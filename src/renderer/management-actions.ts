export async function runAfterExplicitConfirmation(
  confirmed: boolean,
  action: () => void | Promise<void>
): Promise<boolean> {
  if (!confirmed) return false;
  await action();
  return true;
}
