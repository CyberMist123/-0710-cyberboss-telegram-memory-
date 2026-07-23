import { ChevronDownIcon } from "@radix-ui/react-icons";
import * as Select from "@radix-ui/react-select";
import React from "react";

import { getTimelineText } from "../../../infra/i18n/timeline-locale.js";

function TimelineRangeSelector({
  range,
  selectedDate,
  selectedWeek,
  selectedMonth,
  onDateChange,
  onWeekChange,
  onMonthChange,
  data,
  locale,
  weekRangeMode = "calendar",
}) {
  if (range === "day") {
    const dates = data?.meta?.availableDates || [];
    return (
      <RangeDropdown
        value={selectedDate}
        options={dates.map((date) => ({ value: date, label: date }))}
        onChange={onDateChange}
        locale={locale}
      />
    );
  }
  if (range === "week") {
    const weeks = weekRangeMode === "rolling"
      ? buildRollingWeekOptions(data?.meta?.availableDates || [])
      : Object.keys(data?.ranges?.week || {}).sort();
    return (
      <RangeDropdown
        value={selectedWeek}
        options={weeks.map((week) => ({ value: week, label: week }))}
        onChange={onWeekChange}
        locale={locale}
      />
    );
  }
  const months = Object.keys(data?.ranges?.month || {}).sort();
  return (
    <RangeDropdown
      value={selectedMonth}
      options={months.map((month) => ({ value: month, label: month }))}
      onChange={onMonthChange}
      locale={locale}
    />
  );
}

function buildRollingWeekOptions(availableDates) {
  const dates = [...availableDates].sort();
  const earliestDate = dates[0] || "";
  const latestDate = dates[dates.length - 1] || "";
  if (!latestDate) {
    return [];
  }
  const options = [];
  let cursor = latestDate;
  while (cursor && cursor >= earliestDate) {
    options.push(cursor);
    cursor = offsetDateKey(cursor, -7);
  }
  return options;
}

function offsetDateKey(date, dayDelta) {
  const parsed = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(parsed)) {
    return "";
  }
  return new Date(parsed + (dayDelta * 24 * 60 * 60 * 1000)).toISOString().slice(0, 10);
}

function RangeDropdown({ value, options, onChange, locale }) {
  const selected = options.find((option) => option.value === value) || options[0] || null;

  return (
    <Select.Root value={value} onValueChange={onChange}>
      <div className="range-select">
        <Select.Trigger className="range-select-trigger" aria-label={getTimelineText(locale, "selectTimeRange")} data-range-trigger="true">
          <Select.Value>{selected?.label || getTimelineText(locale, "notSelected")}</Select.Value>
          <Select.Icon className="range-select-icon">
            <ChevronDownIcon aria-hidden="true" />
          </Select.Icon>
        </Select.Trigger>
        <Select.Portal>
          <Select.Content className="range-select-menu" position="popper" sideOffset={8}>
            <Select.Viewport className="range-select-viewport">
              {options.map((option) => (
                <Select.Item
                  key={option.value}
                  className="range-select-option"
                  value={option.value}
                  data-range-option-value={option.value}
                  data-range-option-label={option.label}
                >
                  <Select.ItemText>{option.label}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.Viewport>
          </Select.Content>
        </Select.Portal>
      </div>
    </Select.Root>
  );
}

function TimelineRangeTabBar({ value, onChange, items }) {
  return (
    <div className="tabbar">
      {items.map((item) => (
        <button
          type="button"
          key={item.id}
          data-range-id={item.id}
          className={value === item.id ? "active" : ""}
          onClick={() => onChange(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

export { TimelineRangeSelector, TimelineRangeTabBar };
