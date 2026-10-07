import { useEffect, useState } from "react";
import { api, type Me } from "./api";

// R-459: the signed-in person, for a component deep inside a drawer that was not handed one (the
// load page opens from Logistics and from a deal). A local read, so it is asked for on each mount
// rather than cached, and a switch of account is never answered with the last person's rights.
export function useSessionMe(): Me | null {
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    let dead = false;
    api.employeeMe().then((m) => { if (!dead) setMe(m); }).catch(() => { if (!dead) setMe(null); });
    return () => { dead = true; };
  }, []);
  return me;
}
