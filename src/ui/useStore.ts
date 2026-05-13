import { useStore as useZustandStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { store } from "../store";

type State = ReturnType<typeof store.getState>;

export const useStore = <T,>(selector: (s: State) => T): T =>
  useZustandStore(store, selector);

export const useStoreShallow = <T,>(selector: (s: State) => T): T =>
  useZustandStore(store, useShallow(selector));

export const getState = () => store.getState();
