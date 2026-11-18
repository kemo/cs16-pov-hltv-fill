// The chat of CS 1.6. Pure module: runs in Node and in the browser.
//
// CS 1.5 sends a SayText as one text: "[prefix ]name :   text". CS 1.6 sends a title of titles.txt and its
// arguments as separate strings: "#Cstrike_Chat_AllDead", the name (often empty: the client takes it from the
// entity), the text. The prefixes of a title, as the game prints them:

export const CHAT_TITLES = {
  '#Cstrike_Chat_All': {},
  '#Cstrike_Chat_AllDead': { dead: true },
  '#Cstrike_Chat_AllSpec': { spectator: true },
  '#Cstrike_Chat_Spec': { spectator: true, teamOnly: true },
  '#Cstrike_Chat_T': { teamOnly: true },
  '#Cstrike_Chat_CT': { teamOnly: true },
  '#Cstrike_Chat_T_Dead': { dead: true, teamOnly: true },
  '#Cstrike_Chat_CT_Dead': { dead: true, teamOnly: true },
};

/**
 * A chat line of a timeline built before 1.6 titles were read: the title and the start of the text stand in
 * the name, cut at the first " :" of the text. Gives the line as it was said, with the sender's name from
 * `nameOf(entity)`; null for a title that is no chat (a name change); the line itself where it needs nothing.
 */
export function repairChat(line, nameOf) {
  const m = line.name?.match(/^(#Cstrike_\w+)\s*(.*)$/);
  if (!m) return line;
  const title = CHAT_TITLES[m[1]];
  if (!title) return null;
  const text = m[2] ? `${m[2]} :${line.text}` : `:${line.text}`;
  return { ...line, dead: false, spectator: false, teamOnly: false, ...title, name: nameOf(line.entity) ?? '?', text };
}
