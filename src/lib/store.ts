import { create } from "zustand";
import { api, Client } from "./api";

interface AppState {
  clients: Client[];
  selectedClientId: string | null;
  loading: boolean;
  aiOnline: boolean;

  loadClients: () => Promise<void>;
  selectClient: (id: string | null) => void;
  checkAi: () => Promise<void>;
}

export const useAppStore = create<AppState>((set) => ({
  clients: [],
  selectedClientId: null,
  loading: false,
  aiOnline: false,

  loadClients: async () => {
    set({ loading: true });
    try {
      const clients = await api.listClients();
      set({ clients, loading: false });
    } catch (e) {
      console.error(e);
      set({ loading: false });
    }
  },
  selectClient: (id) => set({ selectedClientId: id }),
  checkAi: async () => {
    try {
      const ok = await api.aiHealthCheck();
      set({ aiOnline: ok });
    } catch {
      set({ aiOnline: false });
    }
  },
}));
