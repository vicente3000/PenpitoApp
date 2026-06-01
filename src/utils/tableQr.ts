import { AppEntryQr } from '../models';

const TABLE_QR_PREFIX = 'PENPITO:MESA:';
const WAITER_QR_VALUE = 'PENPITO:MESERO';
const ADMIN_QR_VALUE = 'PENPITO:ADMIN';

export const TABLE_QR_EXAMPLE = `${TABLE_QR_PREFIX}07`;
export const WAITER_QR_EXAMPLE = WAITER_QR_VALUE;
export const ADMIN_QR_EXAMPLE = ADMIN_QR_VALUE;

export function buildTableQr(tableNumber: number) {
  return `${TABLE_QR_PREFIX}${String(tableNumber).padStart(2, '0')}`;
}

export function parseTableQr(rawValue: string) {
  const normalized = rawValue.trim().toUpperCase();
  const match = normalized.match(/^PENPITO:MESA:(\d{1,3})$/);

  if (!match) {
    return null;
  }

  const tableNumber = Number(match[1]);
  if (!Number.isInteger(tableNumber) || tableNumber <= 0) {
    return null;
  }

  return {
    qr_value: buildTableQr(tableNumber),
    table_number: tableNumber,
  };
}

export function parseAccessQr(rawValue: string): AppEntryQr | null {
  const normalized = rawValue.trim().toUpperCase();
  const tableQr = parseTableQr(normalized);

  if (tableQr) {
    return {
      type: 'table',
      qr_value: tableQr.qr_value,
      table_number: tableQr.table_number,
    };
  }

  if (normalized === WAITER_QR_VALUE) {
    return {
      type: 'waiter',
      qr_value: WAITER_QR_VALUE,
    };
  }

  if (normalized === ADMIN_QR_VALUE) {
    return {
      type: 'admin',
      qr_value: ADMIN_QR_VALUE,
    };
  }

  return null;
}

export function formatTableLabel(tableNumber: number) {
  return `Mesa ${tableNumber}`;
}
