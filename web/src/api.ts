// 后端接口调用：JWT 存在 localStorage；401 时退回登录页；错误统一抛出 ApiError（带后端的中文说明）
const TOKEN_KEY = 'ledger-token';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

export const token = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (t: string) => localStorage.setItem(TOKEN_KEY, t),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (fn: () => void) => (onUnauthorized = fn);

async function request<T>(method: string, url: string, body?: unknown, isForm = false): Promise<T> {
  const headers: Record<string, string> = {};
  const t = token.get();
  if (t) headers.authorization = `Bearer ${t}`;
  if (body !== undefined && !isForm) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`/api${url}`, { method, headers, body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, 'NETWORK', '无法连接服务器，请检查网络或稍后重试');
  }
  if (res.status === 401 && !url.startsWith('/auth/login')) {
    token.clear();
    onUnauthorized();
  }
  const isJson = res.headers.get('content-type')?.includes('json');
  const data = isJson ? await res.json() : undefined;
  if (!res.ok) throw new ApiError(res.status, data?.code ?? 'ERROR', data?.message ?? `请求失败（${res.status}）`, data?.details);
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body: unknown = {}) => request<T>('POST', url, body),
  put: <T>(url: string, body: unknown) => request<T>('PUT', url, body),
  patch: <T>(url: string, body: unknown) => request<T>('PATCH', url, body),
  del: <T>(url: string) => request<T>('DELETE', url),
  upload: <T>(url: string, files: File[]) => {
    const form = new FormData();
    files.forEach((f) => form.append('file', f, f.name));
    return request<T>('POST', url, form, true);
  },
  /** 下载文件（导出、模板、附件）：带登录凭证，文件名取自响应头 */
  async download(url: string, fallbackName = 'download.xlsx', body?: unknown) {
    const t = token.get();
    const headers: Record<string, string> = t ? { authorization: `Bearer ${t}` } : {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`/api${url}`, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!res.ok) {
      const data = res.headers.get('content-type')?.includes('json') ? await res.json() : undefined;
      throw new ApiError(res.status, data?.code ?? 'ERROR', data?.message ?? `下载失败（${res.status}）`);
    }
    const cd = res.headers.get('content-disposition') ?? '';
    const m = /filename\*=UTF-8''([^;]+)/.exec(cd);
    const name = m ? decodeURIComponent(m[1]) : fallbackName;
    const blobUrl = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 2000);
    return name;
  },
  /** 构造带查询参数的地址，忽略空值 */
  qs(params: Record<string, string | undefined | null>) {
    const p = Object.entries(params).filter(([, v]) => v);
    return p.length ? `?${p.map(([k, v]) => `${k}=${encodeURIComponent(v!)}`).join('&')}` : '';
  },
};
