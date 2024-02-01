export function getFlagString(value, flags) {
  function _addFlagString(flags, flag) {
    return flags === "" ? flag : `${flags} | ${flag}`;
  }
  let flagStr = "";
  for (const flagName in flags) {
    const flag = flags[flagName];
    if (value & flag) {
      flagStr = _addFlagString(flagStr, flagName);
    }
  }
  return flagStr;
}
