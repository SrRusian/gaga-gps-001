import { useEffect, useState } from 'react';
import { ApiError, adminApi } from '../api';
import type { UserRow } from '../types';

export function UsersSection() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loadError, setLoadError] = useState('');
  const [form, setForm] = useState({ email: '', name: '', password: '', role: 'operator' });

  async function loadUsers() {
    try {
      setUsers(await adminApi.get<UserRow[]>('/api/users'));
      setLoadError('');
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Error cargando usuarios');
    }
  }

  useEffect(() => {
    loadUsers();
  }, []);

  async function toggleUserActive(id: number, currentlyActive: boolean) {
    await adminApi.patch(`/api/users/${id}`, { active: !currentlyActive });
    loadUsers();
  }

  async function createUser() {
    if (!form.email || !form.name || !form.password) {
      alert('Complete todos los campos');
      return;
    }
    await adminApi.post('/api/users', form);
    setForm({ email: '', name: '', password: '', role: 'operator' });
    loadUsers();
  }

  async function deleteUser(id: number) {
    if (!confirm('¿Eliminar usuario?')) return;
    try {
      await adminApi.delete(`/api/users/${id}`);
      loadUsers();
    } catch (err) {
      if (
        err instanceof ApiError &&
        (err.body as { code?: string })?.code === 'USER_HAS_SESSIONS'
      ) {
        if (
          confirm(
            `${err.message}\n\n¿Eliminar también su historial de turnos? Esta acción no se puede deshacer.\n\n(Sugerencia: puede usar el botón "Desactivar" en vez de eliminar, para conservar su historial.)`,
          )
        ) {
          await adminApi.delete(`/api/users/${id}?force=true`);
          loadUsers();
        }
      } else {
        alert(err instanceof Error ? err.message : 'Error eliminando usuario');
      }
    }
  }

  return (
    <>
      <div className="card">
        <h3>Crear usuario</h3>
        <div className="form-row">
          <input
            placeholder="Email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
          <input
            placeholder="Nombre"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <input
            placeholder="Contraseña"
            type="password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
          />
          <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            <option value="operator">Operador</option>
            <option value="supervisor">Supervisor</option>
            <option value="admin">Admin</option>
          </select>
          <button className="btn btn-sm" onClick={createUser}>
            Crear
          </button>
        </div>
      </div>
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Email</th>
              <th>Nombre</th>
              <th>Rol</th>
              <th>Activo</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {loadError ? (
              <tr>
                <td colSpan={5}>{loadError}</td>
              </tr>
            ) : (
              users.map((u) => (
                <tr key={u.id}>
                  <td>{u.email}</td>
                  <td>{u.name}</td>
                  <td>{u.role}</td>
                  <td>{u.active ? 'Sí' : 'No'}</td>
                  <td>
                    <button className="btn btn-sm" onClick={() => toggleUserActive(u.id, u.active)}>
                      {u.active ? 'Desactivar' : 'Activar'}
                    </button>{' '}
                    <button className="btn btn-sm btn-danger" onClick={() => deleteUser(u.id)}>
                      Eliminar
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
