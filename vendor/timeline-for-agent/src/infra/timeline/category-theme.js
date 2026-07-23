const FALLBACK_CATEGORY_ID = "life";

function normalizeCategoryThemeId(rawCategoryId) {
  const normalized = String(rawCategoryId || "").trim().toLowerCase();
  return normalized || FALLBACK_CATEGORY_ID;
}

function buildCategoryTheme(categoryId, fallbackFill = "") {
  const normalizedId = normalizeCategoryThemeId(categoryId);
  const fill = normalizedId.includes(".")
    ? String(fallbackFill || "").trim() || `var(--cat-${FALLBACK_CATEGORY_ID})`
    : `var(--cat-${normalizedId})`;
  const ink = normalizedId.includes(".")
    ? "var(--text)"
    : `var(--cat-${normalizedId}-ink)`;
  return { fill, ink };
}

function resolveCategoryFill(categoryId, fallbackFill = "") {
  return buildCategoryTheme(categoryId, fallbackFill).fill;
}

module.exports = {
  buildCategoryTheme,
  resolveCategoryFill,
};
