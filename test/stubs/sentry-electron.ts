export function init(): void {}
export function close(): Promise<boolean> { return Promise.resolve(true) }
export function setContext(): void {}
export function addBreadcrumb(): void {}
export function captureException(): void {}
export async function startSpan<T>(_options: unknown, callback: () => T | Promise<T>): Promise<T> { return callback() }
