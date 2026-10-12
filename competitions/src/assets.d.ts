declare module '*.css' {
  const text: string;
  export default text;
}
declare module './transport.js' {
  export function installTransport(): void;
}
