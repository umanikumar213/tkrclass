function parseAttendanceSummary(dump) {
  const clean = value => value.replace(/\s+/g, ' ').trim();
  // Never treat unrelated profile/day-table numbers as the overall summary.
  const totals = dump.match(/\bCons\.?\s*Total\b[\s\S]*?(\d+)\s+(\d+)\s+(\d+)\s+(\d+(?:\.\d+)?)\s*%/i);
  const summary = totals ? {
    conducted: Number(totals[1]), present: Number(totals[2]),
    absent: Number(totals[3]), percentage: totals[4],
  } : null;
  const subjectText = (dump.match(/Subject\s+Abb?revi?ation([\s\S]*?)Cons\.?\s*Total/i) || [])[1] || '';
  const subjects = subjectText.split('\n').map(clean).filter(Boolean);
  const attendance = (dump.match(/\bAttendance\b([\s\S]*?)\d+\s+\d+\s+\d+\s+[\d.]+\s*%/i) || [])[1] || '';
  const values = attendance.match(/\d+\/\d+|\b0\b/g) || [];
  const perSubject = subjects.length === values.length
    ? subjects.map((subject, index) => ({ subject, attended: values[index] }))
    : [];
  return { summary, overall: summary?.percentage || '', perSubject };
}
module.exports = { parseAttendanceSummary };
