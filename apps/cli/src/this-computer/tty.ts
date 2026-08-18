/** Whether penguin can draw and read keys: both ends of the terminal are here. */
export function interactive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}
