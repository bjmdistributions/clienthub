import {
  Boxes, Briefcase, Building2, Calendar, ChartColumn, ClipboardList, DollarSign, Ellipsis, Factory, FileText, Folder,
  Handshake, House, Mail, MapPin, Megaphone, Package, Phone, Receipt, Repeat, ShoppingCart, SlidersHorizontal, Star,
  Store, Tag, Truck, Users, Warehouse, Wrench,
  type LucideIcon,
} from "lucide-react";
import type { SectionDef, SectionId } from "./sections";

/** The icon of each built-in sidebar section. Plain lucide, 16px, never inside a tile. */
export const SECTION_ICONS: Record<SectionId, LucideIcon> = {
  home: House,
  invoices: FileText,
  deals: Repeat,
  clients: Users,
  inventory: Package,
  logistics: Truck,
  money: DollarSign,
  insights: ChartColumn,
  more: Ellipsis,
  settings: SlidersHorizontal,
};

/** R-684: the icons a section you made can take, by the name stored in the layout. */
export const ICON_CHOICES: Record<string, LucideIcon> = {
  folder: Folder,
  factory: Factory,
  phone: Phone,
  handshake: Handshake,
  store: Store,
  warehouse: Warehouse,
  boxes: Boxes,
  cart: ShoppingCart,
  truck: Truck,
  briefcase: Briefcase,
  building: Building2,
  clipboard: ClipboardList,
  receipt: Receipt,
  mail: Mail,
  megaphone: Megaphone,
  calendar: Calendar,
  map: MapPin,
  tag: Tag,
  star: Star,
  wrench: Wrench,
};

export function sectionIcon(s: SectionDef): LucideIcon {
  return SECTION_ICONS[s.id as SectionId] ?? (s.icon ? ICON_CHOICES[s.icon] : undefined) ?? Folder;
}
