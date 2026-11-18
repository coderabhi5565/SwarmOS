/**
 * Which pipeline node the hero is focused on. Hovering focuses a node for as
 * long as the pointer stays; clicking (or choosing it in the HUD) locks the
 * focus until it is clicked again, another node is chosen, or the scene's
 * background is clicked. A lock wins over a hover.
 */
export interface FocusState {
  hovered: string | null;
  locked: string | null;
}

export type FocusAction =
  | { type: "hover"; id: string }
  | { type: "leave"; id: string }
  | { type: "toggle"; id: string }
  | { type: "clear" };

export const NO_FOCUS: FocusState = { hovered: null, locked: null };

export function focusReducer(state: FocusState, action: FocusAction): FocusState {
  switch (action.type) {
    case "hover":
      return state.hovered === action.id ? state : { ...state, hovered: action.id };
    case "leave":
      // A late "leave" from a node the pointer already left changes nothing.
      return state.hovered === action.id ? { ...state, hovered: null } : state;
    case "toggle":
      return { ...state, locked: state.locked === action.id ? null : action.id };
    case "clear":
      return state.locked === null ? state : { ...state, locked: null };
  }
}

/** The node in focus: the locked one, else the hovered one. */
export function focusedNode(state: FocusState): string | null {
  return state.locked ?? state.hovered;
}
