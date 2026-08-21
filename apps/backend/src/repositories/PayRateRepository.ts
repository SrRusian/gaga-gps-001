import { query } from '../config/database';

export type RateType = 'per_unit' | 'per_hour';

export interface PayRateRow {
  id: number;
  project_id: number | null;
  device_id: string | null;
  user_id: number | null;
  rate_type: RateType;
  rate_amount: string;
  currency: string;
  valid_from: Date;
  valid_to: Date | null;
  created_by: number | null;
}

class PayRateRepository {
  async create({
    projectId,
    deviceId,
    userId,
    rateType,
    rateAmount,
    currency,
    createdBy,
  }: {
    projectId?: number | null;
    deviceId?: string | null;
    userId?: number | null;
    rateType: RateType;
    rateAmount: number;
    currency?: string;
    createdBy?: number | null;
  }): Promise<PayRateRow> {
    try {
      const { rows } = await query<PayRateRow>(
        `INSERT INTO pay_rates (project_id, device_id, user_id, rate_type, rate_amount, currency, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [
          projectId ?? null,
          deviceId ?? null,
          userId ?? null,
          rateType,
          rateAmount,
          currency ?? 'MXN',
          createdBy ?? null,
        ],
      );
      return rows[0];
    } catch (err) {
      console.error('PayRateRepository.create:', (err as Error).message);
      throw err;
    }
  }

  async findByDateRange(from: Date | string, to: Date | string): Promise<PayRateRow[]> {
    try {
      const { rows } = await query<PayRateRow>(
        `SELECT * FROM pay_rates
         WHERE valid_from <= $2 AND (valid_to IS NULL OR valid_to >= $1)
         ORDER BY valid_from DESC`,
        [from, to],
      );
      return rows;
    } catch (err) {
      console.error('PayRateRepository.findByDateRange:', (err as Error).message);
      throw err;
    }
  }
}

export default PayRateRepository;
