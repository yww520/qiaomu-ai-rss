export interface TimelineGroup {
  key: string;
  label: string;
  order: number;
}

export function getTimelineGroup(entry: { publishedTs?: number | null; published?: string | null }, now = new Date()): TimelineGroup {
  const ts = entry.publishedTs || (entry.published ? Date.parse(entry.published) : 0);
  if (!ts || Number.isNaN(ts)) {
    return { key: 'unknown', label: '更早', order: 9999 };
  }
  const date = new Date(ts);
  const nowYear = now.getFullYear();
  const nowMonth = now.getMonth();
  const nowDate = now.getDate();

  const todayStart = new Date(nowYear, nowMonth, nowDate).getTime();
  const yesterdayStart = todayStart - 86400000;

  const dayOfWeek = now.getDay();
  const diffToMonday = (dayOfWeek === 0 ? 6 : dayOfWeek - 1);
  const thisWeekStart = todayStart - diffToMonday * 86400000;
  const lastWeekStart = thisWeekStart - 7 * 86400000;

  const itemTime = date.getTime();

  if (itemTime >= todayStart) {
    return { key: 'today', label: '今天', order: 1 };
  }
  if (itemTime >= yesterdayStart) {
    return { key: 'yesterday', label: '昨天', order: 2 };
  }
  if (itemTime >= thisWeekStart) {
    return { key: 'this_week', label: '本周', order: 3 };
  }
  if (itemTime >= lastWeekStart) {
    return { key: 'last_week', label: '上周', order: 4 };
  }
  if (date.getFullYear() === nowYear) {
    if (date.getMonth() === nowMonth) {
      return { key: 'this_month_earlier', label: '本月更早', order: 5 };
    }
    const month = date.getMonth() + 1;
    return { key: `month_${nowYear}_${month}`, label: `${month}月`, order: 10 + (12 - month) };
  }
  return { key: `year_${date.getFullYear()}`, label: `${date.getFullYear()}年`, order: 100 + (nowYear - date.getFullYear()) };
}
