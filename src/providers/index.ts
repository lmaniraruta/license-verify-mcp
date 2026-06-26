import type { Provider } from "../types.js";
import { waProvider } from "./wa.js";
import { caProvider } from "./ca.js";

export const providers: Map<string, Provider> = new Map([
  ["WA", waProvider],
  ["CA", caProvider],
]);
