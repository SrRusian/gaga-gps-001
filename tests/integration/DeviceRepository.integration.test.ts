import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool, query } from '../../backend/src/config/database';
import DeviceRepository from '../../backend/src/repositories/DeviceRepository';

const repo = new DeviceRepository();
let testProjectId: number;
let testUserId: number;

beforeAll(async () => {
  const { rows: projectRows } = await query<{ id: number }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [`test-device-repo-${Date.now()}`],
  );
  testProjectId = projectRows[0].id;

  const { rows: userRows } = await query<{ id: number }>(
    `INSERT INTO users (email, password, name, role, project_id)
     VALUES ($1, 'x', 'Test Operator', 'operator', $2) RETURNING id`,
    [`test-device-repo-${Date.now()}@example.com`, testProjectId],
  );
  testUserId = userRows[0].id;
});

afterAll(async () => {
  await query('DELETE FROM users WHERE id = $1', [testUserId]);
  await query('DELETE FROM projects WHERE id = $1', [testProjectId]);
  await pool.end();
});

describe('DeviceRepository - purga real con force=true', () => {
  it('elimina un dispositivo con equipment_activity_segments ligados a un operator_session (orden de FK)', async () => {
    const uniqueId = `TEST-DEVREPO-${Date.now()}`;
    const device = await repo.create({ uniqueId, name: 'Test FK order', projectId: testProjectId });

    const { rows: sessionRows } = await query<{ id: number }>(
      `INSERT INTO operator_sessions (user_id, device_id, project_id) VALUES ($1, $2, $3) RETURNING id`,
      [testUserId, uniqueId, testProjectId],
    );
    const sessionId = sessionRows[0].id;

    // equipment_activity_segments.operator_session_id REFERENCES operator_sessions(id) sin cascade -
    // si el purge borra operator_sessions antes que esto, la fila deja el FK huérfano y 23503
    await query(
      `INSERT INTO equipment_activity_segments (device_id, operator_session_id, activity_type)
       VALUES ($1, $2, 'productive')`,
      [uniqueId, sessionId],
    );

    await expect(repo.delete(device.id, { force: true })).resolves.toBe(true);

    const { rows: remainingSegments } = await query('SELECT 1 FROM equipment_activity_segments WHERE device_id = $1', [uniqueId]);
    const { rows: remainingSessions } = await query('SELECT 1 FROM operator_sessions WHERE device_id = $1', [uniqueId]);
    const { rows: remainingDevice } = await query('SELECT 1 FROM devices WHERE unique_id = $1', [uniqueId]);
    expect(remainingSegments).toHaveLength(0);
    expect(remainingSessions).toHaveLength(0);
    expect(remainingDevice).toHaveLength(0);
  });
});
