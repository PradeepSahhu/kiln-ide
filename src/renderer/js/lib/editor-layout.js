// Split layout of the editor groups: a tree of { type: 'leaf', group } and
// { type: 'split', dir: 'row' | 'column', children, sizes } nodes (sizes are fractions that add up to 1).

export const leaf = (group) => ({ type: 'leaf', group });

/** Group ids in layout order (left to right, top to bottom). */
export function layoutGroups(node) {
  return node.type === 'leaf' ? [node.group] : node.children.flatMap((c) => layoutGroups(c));
}

/**
 * Put group `gid` next to group `from` (right of it for 'row', below it for 'column'). Next to a
 * sibling in a split of the same direction it joins that split; otherwise `from` becomes a new split.
 */
export function splitLayout(node, from, gid, dir) {
  if (node.type === 'leaf') return node.group === from ? { type: 'split', dir, children: [node, leaf(gid)], sizes: [0.5, 0.5] } : node;
  const i = node.children.findIndex((c) => c.type === 'leaf' && c.group === from);
  if (i >= 0 && node.dir === dir) {
    const children = node.children.slice();
    children.splice(i + 1, 0, leaf(gid));
    return { ...node, children, sizes: children.map(() => 1 / children.length) };
  }
  return { ...node, children: node.children.map((c) => splitLayout(c, from, gid, dir)) };
}

/** Remove a group; a split left with one child is replaced by that child. Null when nothing is left. */
export function removeFromLayout(node, gid) {
  if (node.type === 'leaf') return node.group === gid ? null : node;
  const kids = node.children.map((c) => removeFromLayout(c, gid));
  const sizes = node.sizes.filter((_, i) => kids[i]);
  const children = kids.filter(Boolean);
  if (!children.length) return null;
  if (children.length === 1) return children[0];
  const total = sizes.reduce((a, b) => a + b, 0) || 1;
  return { ...node, children, sizes: sizes.map((x) => x / total) };
}

/** Set the sizes of the split at `path` (child indexes from the root). */
export function resizeLayout(node, path, sizes) {
  if (!path.length) return node.type === 'split' ? { ...node, sizes } : node;
  const children = node.children.slice();
  children[path[0]] = resizeLayout(children[path[0]], path.slice(1), sizes);
  return { ...node, children };
}

/** The group after `gid` in layout order (or before it, for the last one); null without splits. */
export function neighborGroup(node, gid) {
  const list = layoutGroups(node);
  if (list.length < 2) return null;
  const i = list.indexOf(gid);
  return list[i + 1] || list[i - 1] || null;
}

/** A saved layout is usable when it is a well-formed tree over exactly the saved groups. */
export function validLayout(node, groupIds) {
  const seen = [];
  const ok = (n) => {
    if (!n || typeof n !== 'object') return false;
    if (n.type === 'leaf') return typeof n.group === 'string' && seen.push(n.group) > 0;
    return n.type === 'split' && (n.dir === 'row' || n.dir === 'column') && Array.isArray(n.children) && n.children.length >= 2 && Array.isArray(n.sizes) && n.sizes.length === n.children.length && n.children.every(ok);
  };
  return ok(node) && seen.length === groupIds.length && seen.every((g) => groupIds.includes(g)) && new Set(seen).size === seen.length;
}
