import type { Account, NewAccountInput } from "./types";

export class ApiError extends Error {
  constructor(public errors: string[]) {
    super(errors.join(" "));
  }
}

async function handle<T>(res: Response): Promise<T> {
  const body = await res.json();
  if (!res.ok) throw new ApiError(body.errors ?? ["Unknown error."]);
  return body as T;
}

export const api = {
  listAccounts: (): Promise<Account[]> => fetch("/api/accounts").then(handle),
  createAccount: (input: NewAccountInput): Promise<Account> =>
    fetch("/api/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }).then(handle),
};
