// 制度確認後にレビューして更新する。表示日付だけで未確認税率を有効にしない。
// 食品1%の成立・施行を自動判定する処理は実装しない。
export const taxPolicyVersion = '2026-10-13-preparation';
export const taxPolicy = {
  STANDARD: { rate: 10, startsAt: '2019-10-01', endsAt: null, state: '施行中', enabled: true, target: '標準税率対象取引' },
  REDUCED_FOOD: { rate: 8, startsAt: '2019-10-01', endsAt: null, state: '施行中', enabled: true, target: '酒類・外食を除く軽減税率対象飲食料品' },
  REDUCED_NEWS: { rate: 8, startsAt: '2019-10-01', endsAt: null, state: '施行中', enabled: true, target: '定期購読契約・週2回以上発行の新聞' },
  TEMP_FOOD: { rate: 1, startsAt: '2027-04-01', endsAt: '2029-03-31', state: '法案・施行未確認', enabled: false, target: '臨時引下げの対象飲食料品（予定）' },
  NON_TAXABLE: { rate: 0, startsAt: null, endsAt: null, state: '取引ごとに確認', enabled: true, target: '非課税取引' },
  EXEMPT: { rate: 0, startsAt: null, endsAt: null, state: '取引ごとに確認', enabled: true, target: '免税等の取引' },
} as const;
export const taxPolicySources = {
  lastReviewedAt: '2026-10-13',
  reduced: 'https://www.nta.go.jp/taxes/shiraberu/zeimokubetsu/shohi/keigenzeiritsu/01.htm',
  temporaryFood: 'https://www.nta.go.jp/taxes/shiraberu/zeimokubetsu/shohi/keigenzeiritsu/zeiritsuhikisage.htm',
};
