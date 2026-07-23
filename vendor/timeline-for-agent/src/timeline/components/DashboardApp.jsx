import React, { useState } from "react";

import { DesktopDashboardView } from "./desktop/DesktopDashboardView.jsx";
import { MobileDashboardView } from "./mobile/MobileDashboardView.jsx";
import { useTimelineDashboardData } from "../hooks/use-timeline-dashboard-data.js";
import { useTimelineSelection } from "../hooks/use-timeline-selection.js";
import { useTimelineViewMode } from "../hooks/use-timeline-view-mode.js";
import { formatRangeSelection } from "../lib/dashboard-helpers.js";
import { getTimelineText, resolveTimelineLocale } from "../../infra/i18n/timeline-locale.js";

function DashboardApp() {
  const chartGridStroke = "var(--chart-grid)";
  const chartAxisStroke = "var(--chart-axis)";
  const {
    data,
    selectedDate,
    selectedMonth,
    selectedWeek,
    setSelectedDate,
    setSelectedMonth,
    setSelectedWeek,
  } = useTimelineDashboardData();
  const [range, setRange] = useState("week");
  const { isMobile } = useTimelineViewMode();
  const locale = resolveTimelineLocale(data?.meta?.locale || "en");
  const {
    activeDetail,
    categories,
    categoryDetail,
    currentAggregate,
    currentKey,
    currentTimeline,
    currentTimelineItemCount,
    selectedCategoryId,
    selectedSubcategoryId,
    selectCategory,
    selectSubcategory,
    styledSubcategories,
  } = useTimelineSelection({
    data,
    range,
    selectedDate,
    selectedMonth,
    selectedWeek: isMobile ? selectedDate : selectedWeek,
    weekRangeMode: isMobile ? "rolling" : "calendar",
  });
  const currentRangeLabel = currentAggregate?.label || formatRangeSelection(range, currentKey, locale) || getTimelineText(locale, "notSelected");

  return (
    <div className="page-shell">
      <div className="page-bg" />
      {isMobile ? (
        <MobileDashboardView
          activeDetail={activeDetail}
          categories={categories}
          categoryDetail={categoryDetail}
          chartAxisStroke={chartAxisStroke}
          chartGridStroke={chartGridStroke}
          currentAggregate={currentAggregate}
          currentKey={currentKey}
          currentTimeline={currentTimeline}
          data={data}
          locale={locale}
          range={range}
          selectedCategoryId={selectedCategoryId}
          selectedDate={selectedDate}
          selectedMonth={selectedMonth}
          selectedSubcategoryId={selectedSubcategoryId}
          selectedWeek={selectedWeek}
          setRange={setRange}
          setSelectedDate={setSelectedDate}
          setSelectedMonth={setSelectedMonth}
          setSelectedWeek={setSelectedWeek}
          selectCategory={selectCategory}
          selectSubcategory={selectSubcategory}
          styledSubcategories={styledSubcategories}
        />
      ) : (
        <DesktopDashboardView
          activeDetail={activeDetail}
          categories={categories}
          categoryDetail={categoryDetail}
          chartAxisStroke={chartAxisStroke}
          chartGridStroke={chartGridStroke}
          currentAggregate={currentAggregate}
          currentKey={currentKey}
          currentRangeLabel={currentRangeLabel}
          currentTimeline={currentTimeline}
          currentTimelineItemCount={currentTimelineItemCount}
          data={data}
          locale={locale}
          range={range}
          selectedCategoryId={selectedCategoryId}
          selectedDate={selectedDate}
          selectedMonth={selectedMonth}
          selectedSubcategoryId={selectedSubcategoryId}
          selectedWeek={selectedWeek}
          setRange={setRange}
          setSelectedDate={setSelectedDate}
          setSelectedMonth={setSelectedMonth}
          setSelectedWeek={setSelectedWeek}
          selectCategory={selectCategory}
          selectSubcategory={selectSubcategory}
          styledSubcategories={styledSubcategories}
        />
      )}
    </div>
  );
}

export { DashboardApp };
