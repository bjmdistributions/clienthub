// R-583 shared components. Import from "../ui" (or "./ui" from a component at the top of components/).
export { default as Tabs } from "./Tabs";
export type { TabItem, TabsProps } from "./Tabs";
export { default as PageHeader, PageActions, PageSlotContext } from "./PageHeader";
export type { PageHeaderProps } from "./PageHeader";
export { default as Button } from "./Button";
export type { ButtonProps } from "./Button";
export { Section, Row } from "./Section";
export { default as Kpi } from "./Kpi";
export type { KpiProps } from "./Kpi";
export { default as MonoAreaChart } from "./MonoAreaChart";
export type { MonoAreaChartProps } from "./MonoAreaChart";
export { useCountUp, prefersReducedMotion, easeOutQuart } from "./motion";
export { compact, mono, niceMax } from "./chartMath";
