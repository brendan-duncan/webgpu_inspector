function getTypeName(type) {
  if (type.isArray) {
    return `array<${getTypeName(type.format)}>`;
  }
  if (type.isTemplate) {
    return `${type.name}<${getTypeName(type.format)}>`;
  }
  return type.name;
}
  
function getNestedStructs(type) {
  if (type.isStruct) {
    const nested = [];
    for (const member of type.members) {
      const structs = getNestedStructs(member.type);
      nested.push(...structs);
    }
    nested.push(type);
    return nested;
  } else if (type.format !== undefined) {
    return getNestedStructs(type.format);
  }
  return [];
}
  
function _getStructFormat(struct) {
  if (!struct?.members) {
    return "";
  }
  let format = `struct ${struct.name} {\n`;
  for (const member of struct.members) {
    format += `  ${member.name}: ${getTypeName(member.type)},\n`;
  }
  format += "}\n";
  return format;
}
  
export function getFormatFromReflection(type) {
  if (type.isArray) {
    return `array<${getFormatFromReflection(type.format)}>`;
  }

  if (type.isStruct) {
    const structs = getNestedStructs(type);
    let format = "";
    for (const s of structs) {
        format += _getStructFormat(s);
    }
    return format;
  }

  if (type.isTemplate) {
    return `${type.name}<${getFormatFromReflection(type.format)}>`;
  }

  return type.name;
}
