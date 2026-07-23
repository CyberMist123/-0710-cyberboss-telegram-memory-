import React from "react";

import { AnalyticsPanels, HeaderStats } from "../DashboardSections.jsx";
import { TimelinePanel } from "../TimelinePanel.jsx";
import { TimelineRangeSelector, TimelineRangeTabBar } from "../shared/TimelineRangeControls.jsx";
import { getTimelineText } from "../../../infra/i18n/timeline-locale.js";

function DesktopDashboardView({
  activeDetail,
  categories,
  categoryDetail,
  chartAxisStroke,
  chartGridStroke,
  currentAggregate,
  currentKey,
  currentRangeLabel,
  currentTimeline,
  currentTimelineItemCount,
  data,
  locale,
  range,
  selectedCategoryId,
  selectedDate,
  selectedMonth,
  selectedSubcategoryId,
  selectedWeek,
  setRange,
  setSelectedDate,
  setSelectedMonth,
  setSelectedWeek,
  selectCategory,
  selectSubcategory,
  styledSubcategories,
}) {
  return (
    <main className="page">
      <HeaderStats
        currentAggregate={currentAggregate}
        currentKey={currentKey}
        currentTimelineItemCount={currentTimelineItemCount}
        data={data}
        locale={locale}
        range={range}
        categories={categories}
      />

      <section className="panel screenshot-target screenshot-target-timeline">
        <div className="toolbar">
          <TimelineRangeTabBar
            value={range}
            onChange={setRange}
            items={[
              { id: "day", label: getTimelineText(locale, "day") },
              { id: "week", label: getTimelineText(locale, "week") },
              { id: "month", label: getTimelineText(locale, "month") },
            ]}
          />
          <TimelineRangeSelector
            range={range}
            selectedDate={selectedDate}
            selectedWeek={selectedWeek}
            selectedMonth={selectedMonth}
            onDateChange={setSelectedDate}
            onWeekChange={setSelectedWeek}
            onMonthChange={setSelectedMonth}
            data={data}
            locale={locale}
          />
        </div>

        {currentTimeline ? (
          <TimelinePanel locale={locale} timeline={currentTimeline} />
        ) : (
          <div className="empty-state">{getTimelineText(locale, "noTimeline")}</div>
        )}
      </section>

      <AnalyticsPanels
        activeDetail={activeDetail}
        categories={categories}
        categoryDetail={categoryDetail}
        chartAxisStroke={chartAxisStroke}
        chartGridStroke={chartGridStroke}
        currentAggregate={currentAggregate}
        currentRangeLabel={currentRangeLabel}
        locale={locale}
        selectedCategoryId={selectedCategoryId}
        selectedSubcategoryId={selectedSubcategoryId}
        styledSubcategories={styledSubcategories}
        onCategorySelect={selectCategory}
        onSubcategorySelect={selectSubcategory}
      />
    </main>
  );
}

export { DesktopDashboardView };
