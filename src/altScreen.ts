const ENTER_ALT_SCREEN = "\x1b[?1049h\x1b[H";
const LEAVE_ALT_SCREEN = "\x1b[?1049l";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

let active = false;

export const enterAltScreen = (): void => {
  if (active) return;
  process.stdout.write(ENTER_ALT_SCREEN + HIDE_CURSOR);
  active = true;
};

export const leaveAltScreen = (): void => {
  if (!active) return;
  process.stdout.write(SHOW_CURSOR + LEAVE_ALT_SCREEN);
  active = false;
};

export const altScreenActive = (): boolean => active;
