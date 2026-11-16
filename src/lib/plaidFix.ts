import { api } from "./api";
import { toast } from "../components/Toast";

// R-652: fix a bank connection in place. Plaid's update mode on the connection this computer already holds: the
// person signs in to the bank in the browser and ticks the accounts to share, and the same connection carries on
// (same history, same place in the feed). Plaid does not count it as a new connection. Used by To book's bank strip
// (R-518, which opened it only for a broken login) and by each bank's Fix connection in Setup.

/** Opens the bank sign-in and waits for it. True once it finished and a pull ran; false if closed or not seen. */
export async function fixBankConnection(id: string, institution: string, cancelled: () => boolean): Promise<boolean> {
  const bank = institution || "your bank";
  const { hosted_link_url, link_token } = await api.plaidReconnectStart(id);
  await api.openExternal(hosted_link_url);
  toast(`Sign in to ${bank} in the browser window that opened, and tick every account you want in Ecliptr.`);
  for (let i = 0; i < 100 && !cancelled(); i++) {
    await new Promise((r) => window.setTimeout(r, 3000));
    const r = await api.plaidReconnectPoll(link_token, id).catch(() => ({ status: "pending" }));
    if (r.status === "done") {
      toast(`${institution || "Your bank"} is fixed. Pulling what it held back.`, "success");
      await api.plaidSync().catch(() => null);
      return true;
    }
    if (r.status === "exited") { toast("The bank sign-in was closed before it finished. Nothing changed."); return false; }
  }
  if (!cancelled()) toast("Did not see the sign-in finish. Try again when you are ready.", "error");
  return false;
}

/** "Savings ··2222", the way account labels read everywhere else. */
export function accountLabel(a: { name: string; mask: string }): string {
  return a.mask ? `${a.name} ··${a.mask}` : a.name;
}
