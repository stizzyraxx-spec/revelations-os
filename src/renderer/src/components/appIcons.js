import {
  Globe, Folder, Settings2, TerminalSquare, FileText, Shield, Store,
  FileStack, Calculator, ShoppingBag, Music2, Scale, AlertTriangle, Heart,
  Microscope, Wine, Target, BookOpen, Lightbulb, Send, TrendingUp, Search,
  LayoutDashboard, Mic, PawPrint, Scissors, Star, BarChart2, Headphones,
  Briefcase, Building, GraduationCap, Hammer, Trophy, Command, Car,
  Building2, ShoppingCart, Waves, BookHeart,
  Flame, Users, Radio, Compass, Gamepad2, BookMarked, HandHeart,
  MessageSquare, UserCircle, ScrollText, DollarSign,
  Clock, Calendar, HelpCircle,
} from 'lucide-react'

export const ICON_MAP = {
  Globe, Folder, Settings2, TerminalSquare, FileText, Shield, Store,
  FileStack, Calculator, ShoppingBag, Music2, Scale, AlertTriangle, Heart,
  Microscope, Wine, Target, BookOpen, Lightbulb, Send, TrendingUp, Search,
  LayoutDashboard, Mic, PawPrint, Scissors, Star, BarChart2, Headphones,
  Briefcase, Building, GraduationCap, Hammer, Trophy, Command, Car,
  Building2, ShoppingCart, Waves, BookHeart,
  Flame, Users, Radio, Compass, Gamepad2, BookMarked, HandHeart,
  MessageSquare, UserCircle, ScrollText, DollarSign,
  Clock, Calendar, HelpCircle,
}

export function getAppIcon(name) {
  return ICON_MAP[name] || Globe
}
