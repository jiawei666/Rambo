export type GroupCreateAction =
  | { type: 'cancel' }
  | { type: 'create'; title: string; purpose: string; botIds: string[] };

export interface GroupCreateCallbacks<T> {
  cancel(): void;
  create(title: string, purpose: string, botIds: string[]): Promise<T>;
}

/** Keep cancellation outside the persistence path; only an explicit submit can create a group. */
export async function runGroupCreateAction<T>(
  action: GroupCreateAction,
  callbacks: GroupCreateCallbacks<T>
): Promise<T | undefined> {
  if (action.type === 'cancel') {
    callbacks.cancel();
    return undefined;
  }
  return callbacks.create(action.title, action.purpose, action.botIds);
}
