export function alignTo(size, alignment) {
  return (size + alignment - 1) & ~(alignment - 1);
}
