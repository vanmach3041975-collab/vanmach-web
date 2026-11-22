import {createHmac, timingSafeEqual} from 'node:crypto';

const fail = (status, message) => { throw Object.assign(new Error(message), {status}); };
// Payment webhook schema contains scalar fields only. Reject schema changes
// rather than accepting ambiguous nested values. Keys never enter logs.
export function verifyPayosWebhook(body, checksumKey) {
  if (typeof checksumKey !== 'string' || !checksumKey.trim()) fail(503, 'Chưa cấu hình xác minh payOS.');
  const data = body?.data;
  if (!data || typeof data !== 'object' || Array.isArray(data) ||
      typeof body.signature !== 'string' || !/^[a-fA-F0-9]{64}$/.test(body.signature)) fail(400, 'Thông báo thanh toán không hợp lệ.');
  const entries = Object.entries(data).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const canonical = entries.map(([key, value]) => {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key) ||
        (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) ||
        (typeof value === 'number' && !Number.isSafeInteger(value))) fail(400, 'Dữ liệu thanh toán không hợp lệ.');
    return `${key}=${value === null || value === 'null' || value === 'undefined' ? '' : value}`;
  }).join('&');
  const expected = createHmac('sha256', checksumKey).update(canonical).digest();
  if (!timingSafeEqual(expected, Buffer.from(body.signature, 'hex'))) fail(401, 'Chữ ký thanh toán không hợp lệ.');
  // The outer success flag is not covered by the signature. Signed data.code
  // must independently indicate success; a return URL can never grant a plan.
  if (body.code !== '00' || body.success !== true || data.code !== '00') fail(400, 'Giao dịch chưa thành công.');
  if (!Number.isSafeInteger(data.orderCode) || data.orderCode <= 0 ||
      !Number.isSafeInteger(data.amount) || data.amount <= 0 || data.currency !== 'VND' ||
      !['paymentLinkId', 'reference', 'accountNumber'].every(key => typeof data[key] === 'string' && data[key].length > 0 && data[key].length <= 200)) {
    fail(400, 'Thông tin giao dịch không đầy đủ.');
  }
  return Object.freeze({...data});
}

// expectedOrder must be read from the server's immutable checkout record,
// never supplied by the browser. Replay/grant transaction is a separate layer.
export function matchPayosOrder(transaction, expectedOrder) {
  if (!expectedOrder || transaction.orderCode !== expectedOrder.orderCode ||
      transaction.paymentLinkId !== expectedOrder.paymentLinkId ||
      transaction.amount !== expectedOrder.amount ||
      transaction.accountNumber !== expectedOrder.accountNumber ||
      transaction.currency !== 'VND') fail(409, 'Thanh toán không khớp đơn hàng đã tạo.');
  return true;
}
