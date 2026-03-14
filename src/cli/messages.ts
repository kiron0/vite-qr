export function printThanksMessage(log: (...args: unknown[]) => void = console.log): void {
  log('');
  log('Thanks for using vite-qr!');
}
