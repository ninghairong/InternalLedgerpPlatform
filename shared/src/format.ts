// 金额在程序中以"分"为整数；这里负责展示、输入与数据库字符串之间的换算。

export const toCents = (yuan: number | null | undefined) => Math.round((yuan ?? 0) * 100);
export const toYuan = (cents: number) => cents / 100;

export function money(cents: number, opts: { sign?: boolean; unit?: boolean } = {}) {
  const v = Math.round(cents) / 100;
  const s = Math.abs(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sign = v < 0 ? '-' : opts.sign && v > 0 ? '+' : '';
  return `${sign}${opts.unit ? '¥' : ''}${s}`;
}

/** 大额简写：12.34万 */
export function moneyShort(cents: number) {
  const v = cents / 100;
  if (Math.abs(v) >= 1e8) return `${(v / 1e8).toFixed(2)}亿`;
  if (Math.abs(v) >= 1e4) return `${(v / 1e4).toFixed(2)}万`;
  return v.toFixed(2);
}

const DIGITS = '零壹贰叁肆伍陆柒捌玖';
const UNITS = ['', '拾', '佰', '仟'];
const SECTIONS = ['', '万', '亿', '万亿'];

/** 人民币大写，用于录入时回显确认 */
export function cnUpper(cents: number): string {
  if (!Number.isFinite(cents)) return '';
  const neg = cents < 0;
  let n = Math.abs(Math.round(cents));
  const fen = n % 10;
  const jiao = Math.floor(n / 10) % 10;
  let yuan = Math.floor(n / 100);
  if (yuan === 0 && jiao === 0 && fen === 0) return '零元整';
  let out = '';
  let sec = 0;
  let needZero = false;
  while (yuan > 0) {
    const part = yuan % 10000;
    if (part > 0) {
      let s = '';
      let zero = false;
      for (let i = 0; i < 4; i++) {
        const d = Math.floor(part / 10 ** i) % 10;
        if (d === 0) {
          if (s) zero = true;
        } else {
          s = DIGITS[d] + UNITS[i] + (zero ? '零' : '') + s;
          zero = false;
        }
      }
      out = s + SECTIONS[sec] + (needZero ? '零' : '') + out;
      needZero = part < 1000;
    } else if (out) {
      needZero = true;
    }
    yuan = Math.floor(yuan / 10000);
    sec++;
  }
  if (out) out += '元';
  if (jiao === 0 && fen === 0) out += '整';
  else {
    if (jiao > 0) out += DIGITS[jiao] + '角';
    else if (out) out += '零';
    if (fen > 0) out += DIGITS[fen] + '分';
  }
  return (neg ? '负' : '') + out;
}

/** 本地日期 YYYY-MM-DD（服务器时区设为 Asia/Shanghai） */
export function today(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export const daysSince = (date: string, ref = today()) => Math.round((Date.parse(ref) - Date.parse(date)) / 86400000);

/** 数据库 numeric 字符串 → 分（不经过浮点） */
export function centsFromDecimal(v: string | number | null | undefined): number {
  if (v === null || v === undefined || v === '') return 0;
  const str = typeof v === 'number' ? v.toFixed(2) : v;
  const neg = str.startsWith('-');
  const [int, frac = ''] = (neg ? str.slice(1) : str).split('.');
  const cents = Number(int) * 100 + Number((frac + '00').slice(0, 2));
  return neg ? -cents : cents;
}

/** 分 → 数据库 numeric 字符串 */
export function decimalFromCents(cents: number): string {
  if (!Number.isSafeInteger(cents)) throw new Error(`invalid cents: ${cents}`);
  const neg = cents < 0;
  const a = Math.abs(cents);
  return `${neg ? '-' : ''}${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`;
}
