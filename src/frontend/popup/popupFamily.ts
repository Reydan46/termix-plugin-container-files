/**
 * A child popup (a path picker opened by another popup) lives and dies with
 * its parent: it is orphaned once the parent is no longer an open window.
 * Grandchildren follow one render later, as each child checks its own parent.
 */
export function isOrphaned(
  parentId: string | undefined,
  liveIds: readonly string[],
): boolean {
  return parentId !== undefined && !liveIds.includes(parentId);
}

/**
 * A child popup stays above its owner for good: when the owner was raised
 * (clicked, dragged) over the child, the child has to be raised again.
 */
export function mustRaiseOverParent(
  parentZ: number | undefined,
  ownZ: number,
): boolean {
  return parentZ !== undefined && parentZ >= ownZ;
}
