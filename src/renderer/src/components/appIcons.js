import {
  Globe, Folder, Settings2, TerminalSquare, FileText, Shield, Store,
  FileStack, Calculator, ShoppingBag, Music2, Scale, AlertTriangle, Heart,
  Microscope, Wine, Target, BookOpen, Lightbulb, Send, TrendingUp, Search,
  LayoutDashboard, Mic, PawPrint, Scissors, Star, BarChart2, Headphones,
  Briefcase, Building, GraduationCap, Hammer, Trophy, Command, Car,
  Building2, ShoppingCart, Waves, BookHeart,
} from 'lucide-react'

export const ICON_MAP = {
  Globe, Folder, Settings2, TerminalSquare, FileText, Shield, Store,
  FileStack, Calculator, ShoppingBag, Music2, Scale, AlertTriangle, Heart,
  Microscope, Wine, Target, BookOpen, Lightbulb, Send, TrendingUp, Search,
  LayoutDashboard, Mic, PawPrint, Scissors, Star, BarChart2, Headphones,
  Briefcase, Building, GraduationCap, Hammer, Trophy, Command, Car,
  Building2, ShoppingCart, Waves, BookHeart,
}

export function getAppIcon(name) {
  return ICON_MAP[name] || Globe
}
