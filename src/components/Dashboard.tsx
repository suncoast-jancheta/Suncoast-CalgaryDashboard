import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { 
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, 
  LineChart, Line, PieChart, Pie, Cell, AreaChart, Area, LabelList 
} from "recharts";
import { 
  TrendingUp, Users, DollarSign, Target, 
  BarChart3, PieChart as PieChartIcon, 
  ArrowUpRight, ArrowDownRight, Calendar,
  FileText, CheckCircle2, Clock, Edit2, Save, X, Settings, RefreshCw, AlertCircle, Briefcase, LogIn, LogOut,
  Flag
} from "lucide-react";
import { auth } from "../firebase";
import { signOut } from "firebase/auth";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { db } from "../firebase";
import { handleFirestoreError, OperationType } from "../firebase";
import { doc, getDoc, setDoc, onSnapshot } from "firebase/firestore";
import { fetchMondayData, fetchBoards, fetchColumns, MondayItem } from "../services/mondayService";

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const BRAND_COLORS = {
  gold: "#C49A3C",
  darkGold: "#A67C2E",
  charcoal: "#2B2B2B",
  black: "#1A1A1A",
  cream: "#F5F3EE",
  warmCream: "#FAF8F3",
  grayLight: "#E5E2DB",
  grayMid: "#8C8478",
  grayWarm: "#6B6359",
  green: "#C49A3C", // For 2026 values (Gold)
  orange: "#8C8478"  // For 2025 values (Gray)
};

const formatCompact = (val: number) => {
  if (val >= 1000000) {
    return `$${(val / 1000000).toFixed(1)}M`;
  }
  if (val >= 1000) {
    return `$${Math.round(val / 1000)}k`;
  }
  return `$${Math.round(val)}`;
};

const formatValue = (val: number) => {
  return `$${Math.round(val).toLocaleString()}`;
};

const formatNumber = (val: number) => {
  return Math.round(val).toLocaleString();
};

const CustomTick = (props: any) => {
  const { x, y, payload } = props;
  const name = payload.value;
  
  // Split name into multiple lines if it's long or has spaces
  const words = name.split(' ');
  
  if (words.length > 1) {
    return (
      <g transform={`translate(${x},${y})`}>
        <text x={0} y={0} dy={12} textAnchor="middle" fill="#94a3b8" fontSize={9} className="font-medium">
          <tspan x={0} dy="0">{words[0]}</tspan>
          <tspan x={0} dy="11">{words.slice(1).join(' ')}</tspan>
        </text>
      </g>
    );
  }

  return (
    <g transform={`translate(${x},${y})`}>
      <text x={0} y={0} dy={12} textAnchor="middle" fill="#94a3b8" fontSize={9} className="font-medium">
        {name}
      </text>
    </g>
  );
};

interface DashboardProps {
  userRole: "admin" | "viewer";
  user?: any;
  onLogout: () => void;
}

interface BoardConfig {
  boardId: string;
  mondayApiKey?: string;
  salesAmountColumnId: string;
  soldDateColumnId: string;
  initialContactDateColumnId: string;
  salesRepColumnId: string;
  quoteStatusColumnId: string;
  refreshIntervalHours: number;
  lastRefreshAt?: string;
  includedSalesReps?: string[];
}

// Standalone processing function to calculate dashboard stats
const calculateProcessedData = (items: MondayItem[], config: BoardConfig, goals: any, dateRange: { start: string; end: string }) => {
  const monthlySalesMap: Record<string, number> = {};
  const individualSalesMap: Record<string, { sales: number; quotes: number; closed: number }> = {};
  let totalSales = 0;
  let totalJobsSold = 0;
  let totalLeads = 0;
  let totalQuoted = 0;
  
  const stats = {
    totalFetched: items.length,
    inRange: 0,
    isSold: 0,
    ignored: 0
  };

  const uniqueReps = new Set<string>();

  items.forEach(item => {
    const repName = item.column_values.find(cv => cv.id === config.salesRepColumnId)?.text || "Unknown";
    const primaryRep = repName.split(',')[0].trim() || "Unknown";
    
    const amountCol = item.column_values.find(cv => cv.id === config.salesAmountColumnId);
    const soldDateCol = item.column_values.find(cv => cv.id === config.soldDateColumnId);
    const contactDateCol = item.column_values.find(cv => cv.id === config.initialContactDateColumnId);
    const status = item.column_values.find(cv => cv.id === config.quoteStatusColumnId)?.text || "";

    // Parse Amount
    let amount = 0;
    if (amountCol?.value) {
      try {
        const valObj = JSON.parse(amountCol.value);
        if (typeof valObj === 'object' && valObj !== null) {
          amount = parseFloat(valObj.number || valObj.value || "0") || 0;
        } else {
          amount = parseFloat(valObj) || 0;
        }
      } catch {
        amount = parseFloat(amountCol.text.replace(/[^0-9.-]+/g, "")) || 0;
      }
    } else {
      amount = parseFloat(amountCol?.text.replace(/[^0-9.-]+/g, "") || "0") || 0;
    }
    
    // Parse Dates
    let soldDateStr = "";
    if (soldDateCol?.value) {
      try {
        const valObj = JSON.parse(soldDateCol.value);
        if (typeof valObj === 'object' && valObj !== null) {
          soldDateStr = valObj.date || "";
        } else {
          soldDateStr = typeof valObj === 'string' ? valObj : "";
        }
      } catch {
        soldDateStr = soldDateCol.text ? soldDateCol.text.split(' ')[0] : "";
      }
    } else {
      soldDateStr = soldDateCol?.text ? soldDateCol.text.split(' ')[0] : "";
    }

    let contactDateStr = "";
    if (contactDateCol?.value) {
      try {
        const valObj = JSON.parse(contactDateCol.value);
        if (typeof valObj === 'object' && valObj !== null) {
          contactDateStr = valObj.date || "";
        } else {
          contactDateStr = typeof valObj === 'string' ? valObj : "";
        }
      } catch {
        contactDateStr = contactDateCol.text ? contactDateCol.text.split(' ')[0] : "";
      }
    } else {
      contactDateStr = contactDateCol?.text ? contactDateCol.text.split(' ')[0] : "";
    }
    
    const normalizeDate = (d: string) => {
      if (!d) return "";
      if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(d)) {
        const parts = d.split('-');
        return `${parts[0]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`;
      }
      if (d.includes('/')) {
        const parts = d.split('/');
        if (parts.length === 3) {
          const p0 = parts[0].padStart(2, '0');
          const p1 = parts[1].padStart(2, '0');
          const p2 = parts[2];
          if (p2.length === 4) {
            if (parseInt(p0) > 12) return `${p2}-${p1}-${p0}`;
            return `${p2}-${p0}-${p1}`;
          }
        }
      }
      try {
        const parsed = new Date(d);
        if (!isNaN(parsed.getTime())) {
          const year = parsed.getFullYear();
          const month = String(parsed.getMonth() + 1).padStart(2, '0');
          const day = String(parsed.getDate()).padStart(2, '0');
          return `${year}-${month}-${day}`;
        }
      } catch (e) {}
      return d;
    };

    const sDate = normalizeDate(soldDateStr);
    const cDate = normalizeDate(contactDateStr);

    const isSoldInRange = sDate && sDate >= dateRange.start && sDate <= dateRange.end;
    const isInitialContactInRange = cDate && cDate >= dateRange.start && cDate <= dateRange.end;

    const lowerStatus = status.toLowerCase().trim();
    const isActuallySold = (
      lowerStatus.includes("sold") || 
      lowerStatus.includes("won") || 
      lowerStatus.includes("closed") ||
      lowerStatus.includes("completed") ||
      lowerStatus.includes("job sold") ||
      lowerStatus.includes("paid") ||
      lowerStatus.includes("finalized") ||
      lowerStatus === "sold" ||
      lowerStatus === "closed" ||
      lowerStatus === "won" ||
      lowerStatus === "done" ||
      lowerStatus === "success"
    ) && !lowerStatus.includes("lost") && !lowerStatus.includes("cancel") && !lowerStatus.includes("duplicate");

    // Quoted logic: has amount OR status implies quote sent
    const isQuoted = amount > 0 || 
                     lowerStatus.includes("quote") || 
                     lowerStatus.includes("proposal") || 
                     lowerStatus.includes("sent") ||
                     lowerStatus.includes("waiting") ||
                     isActuallySold;

    if (primaryRep !== "Unknown" && (isInitialContactInRange || (isSoldInRange && isActuallySold))) {
      uniqueReps.add(primaryRep);
    }

    if (config.includedSalesReps && config.includedSalesReps.length > 0) {
      if (!config.includedSalesReps.includes(primaryRep)) {
        stats.ignored++;
        return;
      }
    }

    if (isSoldInRange || isInitialContactInRange) {
      stats.inRange++;
    } else {
      stats.ignored++;
    }

    if (isActuallySold) stats.isSold++;

    if (isSoldInRange && isActuallySold) {
      totalSales += amount;
      totalJobsSold += 1;

      const dateParts = sDate.split('-');
      if (dateParts.length === 3) {
        const monthIndex = parseInt(dateParts[1]) - 1;
        const month = MONTHS[monthIndex];
        monthlySalesMap[month] = (monthlySalesMap[month] || 0) + amount;
      }

      if (!individualSalesMap[primaryRep]) {
        individualSalesMap[primaryRep] = { sales: 0, quotes: 0, closed: 0 };
      }
      individualSalesMap[primaryRep].sales += amount;
      individualSalesMap[primaryRep].closed += 1;
    }

    if (isInitialContactInRange || (isSoldInRange && isActuallySold)) {
      totalLeads += 1;
      if (isQuoted) totalQuoted += 1;
      
      if (!individualSalesMap[primaryRep]) {
        individualSalesMap[primaryRep] = { sales: 0, quotes: 0, closed: 0 };
      }
      if (isQuoted) individualSalesMap[primaryRep].quotes += 1;
    }
  });

  const monthlySales = MONTHS.map(m => ({
    name: m,
    sales: monthlySalesMap[m] || 0,
    goal: Math.floor(goals.companyAnnualGoal / 12)
  }));

  const individualSales = Object.entries(individualSalesMap).map(([name, stats]) => ({
    name,
    ...stats,
    goal: goals.individualAnnualGoal
  })).sort((a, b) => b.sales - a.sales);

  const currentMonthIndex = new Date().getMonth();
  const currentMonthName = MONTHS[currentMonthIndex];
  const currentMonthSales = monthlySalesMap[currentMonthName] || 0;

  return {
    monthlySales,
    individualSales,
    totalSales,
    currentMonthSales,
    totalQuoted,
    totalClosed: totalJobsSold,
    totalLeads,
    averageSale: totalJobsSold > 0 ? totalSales / totalJobsSold : 0,
    stats,
    uniqueReps: Array.from(uniqueReps).sort()
  };
};

interface YearData {
  totalSales: number;
  totalQuoted: number;
  totalClosed: number;
  totalLeads: number;
  averageSale: number;
  currentMonthSales: number;
}

const initialYearData: YearData = {
  totalSales: 0,
  totalQuoted: 0,
  totalClosed: 0,
  totalLeads: 0,
  averageSale: 0,
  currentMonthSales: 0
};

export default function Dashboard({ userRole, user, onLogout }: DashboardProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [availableSalesReps, setAvailableSalesReps] = useState<string[]>([]);
  
  const [goals, setGoals] = useState({
    companyAnnualGoal: 16000000,
    individualAnnualGoal: 3200000,
    year: 2026
  });

  const [config, setConfig] = useState<BoardConfig>({
    boardId: "",
    mondayApiKey: "",
    salesAmountColumnId: "",
    soldDateColumnId: "",
    initialContactDateColumnId: "",
    salesRepColumnId: "",
    quoteStatusColumnId: "",
    refreshIntervalHours: 24
  });

  const [processedData, setProcessedData] = useState<{
    monthlySales: any[];
    individualSales: any[];
    data2026: YearData;
    data2025: YearData;
    stats?: {
      totalFetched: number;
      inRange: number;
      isSold: number;
      ignored: number;
    };
  }>({
    monthlySales: [],
    individualSales: [],
    data2026: initialYearData,
    data2025: initialYearData,
    stats: {
      totalFetched: 0,
      inRange: 0,
      isSold: 0,
      ignored: 0
    }
  });

  const [currentSalesPage, setCurrentSalesPage] = useState(0);
  const itemsPerPage = 5; // Updated to 5 per slide

  const [currentMonthPage, setCurrentMonthPage] = useState(0);
  const monthsPerPage = 4; // 4 months per slide

  const [isEditingGoals, setIsEditingGoals] = useState(false);
  const [isConfiguringBoard, setIsConfiguringBoard] = useState(false);
  const [availableBoards, setAvailableBoards] = useState<{ id: string; name: string }[]>([]);
  const [availableColumns, setAvailableColumns] = useState<{ id: string; title: string; type: string }[]>([]);
  const [isSyncing, setIsSyncing] = useState(false);
  const [dateRange] = useState({ start: "2026-01-01", end: "2026-12-31" });

  useEffect(() => {
    if (processedData.individualSales.length <= itemsPerPage) {
      setCurrentSalesPage(0);
      return;
    }

    const interval = setInterval(() => {
      setCurrentSalesPage(prev => {
        const nextPage = prev + 1;
        const totalPages = Math.ceil(processedData.individualSales.length / itemsPerPage);
        return nextPage >= totalPages ? 0 : nextPage;
      });
    }, 10000); // 10 seconds per slide for TV

    return () => clearInterval(interval);
  }, [processedData.individualSales.length]);

  // Monthly Sales Slideshow
  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentMonthPage(prev => {
        const nextPage = prev + 1;
        const totalPages = Math.ceil(MONTHS.length / monthsPerPage);
        return nextPage >= totalPages ? 0 : nextPage;
      });
    }, 12000); // 12 seconds per slide for months

    return () => clearInterval(interval);
  }, []);

  const paginatedSales = processedData.individualSales.sort((a, b) => b.sales - a.sales).slice(
    currentSalesPage * itemsPerPage,
    (currentSalesPage + 1) * itemsPerPage
  );

  const paginatedMonths = processedData.monthlySales.slice(
    currentMonthPage * monthsPerPage,
    (currentMonthPage + 1) * monthsPerPage
  );

  const [quotaExceeded, setQuotaExceeded] = useState(false);
  const [writeQuotaExceeded, setWriteQuotaExceeded] = useState(false);
  const isWritingRef = useRef(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);
  const [isFromCache, setIsFromCache] = useState(false);
  const [mondayData, setMondayData] = useState<MondayItem[]>([]);

  // Listen for Dashboard Data (Materialized View)
  useEffect(() => {
    const currentYear = "2026";
    
    // Try to load from localStorage first
    const cachedData = localStorage.getItem(`dashboard_data_${currentYear}`);
    if (cachedData) {
      try {
        const data = JSON.parse(cachedData);
        if (data.data2026) {
          setProcessedData(data);
        } else {
          // Fallback for old structure
          const newData = {
            monthlySales: data.monthlySales || [],
            individualSales: data.individualSales || [],
            data2026: {
              totalSales: data.totalSales || 0,
              currentMonthSales: data.currentMonthSales || 0,
              totalQuoted: data.totalQuoted || data.totalQuotes || 0,
              totalClosed: data.totalClosed || 0,
              totalLeads: data.totalLeads || 0,
              averageSale: data.averageSale || 0,
            },
            data2025: initialYearData,
            stats: data.stats,
          };
          setProcessedData(newData as any);
        }
        
        if (data.lastSyncedAt) {
          setLastSyncedAt(new Date(data.lastSyncedAt));
        }
        setLoading(false);
      } catch (e) {
        console.error("Failed to parse cached dashboard data", e);
      }
    }

    // Also try to load raw mondayData from localStorage if available
    const cachedMondayData = localStorage.getItem(`monday_data_${config.boardId}`);
    if (cachedMondayData) {
      try {
        const data = JSON.parse(cachedMondayData);
        setMondayData(data);
      } catch (e) {}
    }

    const unsub = onSnapshot(doc(db, "dashboard_data", currentYear), (doc) => {
      if (doc.exists()) {
        const data = doc.data() as any;
        // If data is in new structure, use it directly
        if (data.data2026) {
          setProcessedData(data);
          localStorage.setItem(`dashboard_data_${currentYear}`, JSON.stringify(data));
        } else {
          // Fallback for old structure
          const newData = {
            monthlySales: data.monthlySales || [],
            individualSales: data.individualSales || [],
            data2026: {
              totalSales: data.totalSales || 0,
              currentMonthSales: data.currentMonthSales || 0,
              totalQuoted: data.totalQuoted || data.totalQuotes || 0,
              totalClosed: data.totalClosed || 0,
              totalLeads: data.totalLeads || 0,
              averageSale: data.averageSale || 0,
            },
            data2025: initialYearData,
            stats: data.stats,
          };
          setProcessedData(newData as any);
          localStorage.setItem(`dashboard_data_${currentYear}`, JSON.stringify(newData));
        }
        
        if (data.lastSyncedAt) {
          setLastSyncedAt(new Date(data.lastSyncedAt));
        }
        setLoading(false); // Instantly hide loading screen if we have cached data
      }
    }, (error) => {
      if (error instanceof Error && error.message.includes('resource-exhausted')) {
        console.error("Firestore Read Quota Exceeded for dashboard_data");
        setQuotaExceeded(true);
        setLoading(false); // Hide loading so user can see cached data
      } else {
        // If it's not a quota error, we still want to log it but maybe not crash
        console.warn("Firestore listener error:", error);
      }
    });
    return () => unsub();
  }, [config.boardId]);

  // Update localStorage when mondayData changes (if not too large)
  useEffect(() => {
    if (mondayData.length > 0 && config.boardId) {
      try {
        const dataStr = JSON.stringify(mondayData);
        // Only cache if under 2MB to avoid localStorage limits
        if (dataStr.length < 2000000) {
          localStorage.setItem(`monday_data_${config.boardId}`, dataStr);
        }
      } catch (e) {
        console.warn("Failed to cache mondayData in localStorage (likely too large)");
      }
    }
  }, [mondayData, config.boardId]);

  // Listen for Goals
  useEffect(() => {
    const currentYear = "2026";
    
    // Try to load from localStorage first
    const cachedGoals = localStorage.getItem(`goals_${currentYear}`);
    if (cachedGoals) {
      try {
        setGoals(JSON.parse(cachedGoals));
      } catch (e) {}
    }

    const unsub = onSnapshot(doc(db, "goals", currentYear), (doc) => {
      if (doc.exists()) {
        const data = doc.data() as any;
        const newGoals = { ...data, year: 2026 };
        setGoals(newGoals);
        localStorage.setItem(`goals_${currentYear}`, JSON.stringify(newGoals));
      }
    }, (error) => {
      if (error instanceof Error && error.message.includes('resource-exhausted')) {
        console.error("Firestore Read Quota Exceeded for goals");
        setQuotaExceeded(true);
      } else {
        console.warn("Goals listener error:", error);
      }
    });
    return () => unsub();
  }, []);

  // Listen for Config
  useEffect(() => {
    // Try to load from localStorage first
    const cachedConfig = localStorage.getItem('config_main');
    if (cachedConfig) {
      try {
        setConfig(JSON.parse(cachedConfig));
      } catch (e) {}
    }

    const unsub = onSnapshot(doc(db, "config", "main"), (doc) => {
      if (doc.exists()) {
        const data = doc.data() as BoardConfig;
        setConfig(data);
        localStorage.setItem('config_main', JSON.stringify(data));
      }
    }, (error) => {
      if (error instanceof Error && error.message.includes('resource-exhausted')) {
        console.error("Firestore Read Quota Exceeded for config");
        setQuotaExceeded(true);
      } else {
        console.warn("Config listener error:", error);
      }
    });
    return () => unsub();
  }, []);

  // Fetch Boards for Admin
  useEffect(() => {
    if (userRole === "admin" && isConfiguringBoard) {
      fetchBoards(false, config.mondayApiKey).then(boards => {
        setAvailableBoards(boards);
        
        const calgaryBoard = boards.find(b => b.name === "Calgary (Main)");
        if (calgaryBoard && !config.boardId) {
          // Auto-select if not set
          setConfig(prev => ({ ...prev, boardId: calgaryBoard.id }));
        }
      }).catch(err => {
        console.error("Failed to fetch boards:", err);
        setError("Could not fetch boards. Check your MONDAY_API_KEY.");
      });
    }
  }, [userRole, isConfiguringBoard, config.boardId]);

  // Fetch Columns when board is selected
  useEffect(() => {
    if (userRole === "admin" && isConfiguringBoard && config.boardId) {
      fetchColumns(config.boardId, config.mondayApiKey).then(setAvailableColumns).catch(err => {
        console.error("Failed to fetch columns:", err);
        setError("Could not fetch columns for the selected board.");
      });
    } else {
      setAvailableColumns([]);
    }
  }, [userRole, isConfiguringBoard, config.boardId]);

  // Process Monday.com Data for 2025 and 2026
  const processData = useCallback((items: MondayItem[]) => {
    if (!config.boardId) return;

    const result2026 = calculateProcessedData(items, config, goals, { start: "2026-01-01", end: "2026-12-31" });
    const result2025 = calculateProcessedData(items, config, goals, { start: "2025-01-01", end: "2025-12-31" });

    setAvailableSalesReps(result2026.uniqueReps);

    // Merge monthly sales for comparison chart
    const mergedMonthlySales = MONTHS.map((month) => {
      const m2026 = result2026.monthlySales.find(m => m.name === month);
      const m2025 = result2025.monthlySales.find(m => m.name === month);
      return {
        name: month,
        sales2026: m2026?.sales || 0,
        sales2025: m2025?.sales || 0,
        goal: m2026?.goal || 0
      };
    });

    setProcessedData({
      monthlySales: mergedMonthlySales,
      individualSales: result2026.individualSales,
      data2026: {
        totalSales: result2026.totalSales,
        totalQuoted: result2026.totalQuoted,
        totalClosed: result2026.totalClosed,
        totalLeads: result2026.totalLeads,
        averageSale: result2026.averageSale,
        currentMonthSales: result2026.currentMonthSales
      },
      data2025: {
        totalSales: result2025.totalSales,
        totalQuoted: result2025.totalQuoted,
        totalClosed: result2025.totalClosed,
        totalLeads: result2025.totalLeads,
        averageSale: result2025.averageSale,
        currentMonthSales: result2025.currentMonthSales
      },
      stats: result2026.stats
    });
  }, [config, goals, userRole]);

  // Re-process data when dependencies change
  useEffect(() => {
    if (mondayData.length > 0) {
      processData(mondayData);
    }
  }, [mondayData, processData]);

  // Helper to check if we need a scheduled refresh (6 AM)
  const checkScheduledRefresh = useCallback(() => {
    if (!config.lastRefreshAt) return true;

    const now = new Date();
    const lastRefresh = new Date(config.lastRefreshAt);
    
    // Scheduled time: 6 AM
    const schedule = [6];
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    // Find the most recent scheduled time (6 AM today or 6 AM yesterday)
    let mostRecentScheduledTime = new Date(today);
    mostRecentScheduledTime.setHours(6, 0, 0, 0);
    
    if (now < mostRecentScheduledTime) {
      // If it's before 6 AM today, the most recent 6 AM was yesterday
      mostRecentScheduledTime.setDate(mostRecentScheduledTime.getDate() - 1);
    }

    return lastRefresh < mostRecentScheduledTime;
  }, [config.lastRefreshAt]);

  // Fetch Data when config changes
  const fetchData = useCallback(async (force = false) => {
    if (!config.boardId) return;
    
    // Only show full-screen loading if we have no data at all
    if (processedData.monthlySales.length === 0) {
      setLoading(true);
    }
    
    const columnIds = [
      config.salesAmountColumnId,
      config.soldDateColumnId,
      config.initialContactDateColumnId,
      config.salesRepColumnId,
      config.quoteStatusColumnId
    ].filter(Boolean);

    // Helper to load from localStorage synchronously
    const loadFromLocalStorage = () => {
      const cachedMondayData = localStorage.getItem(`monday_data_${config.boardId}`);
      if (cachedMondayData) {
        try {
          const items = JSON.parse(cachedMondayData);
          if (Array.isArray(items) && items.length > 0) {
            setMondayData(items);
            processData(items);
            setIsFromCache(true);
            return true;
          }
        } catch (e) {
          console.error("Failed to parse localStorage mondayData", e);
        }
      }
      return false;
    };

      const loadFromCache = async (ignoreColumnMismatch = false) => {
        // Before hitting Firestore, try localStorage one more time if we don't have data
        if (mondayData.length === 0) {
          if (loadFromLocalStorage() && !force) {
            return true;
          }
        }

        let cacheDoc;
        try {
          cacheDoc = await getDoc(doc(db, "board_cache", config.boardId));
        } catch (error) {
          if (error instanceof Error && error.message.includes('resource-exhausted')) {
            console.error("Firestore Read Quota Exceeded for board_cache");
            setQuotaExceeded(true);
            // Fallback to localStorage if Firestore fails
            return loadFromLocalStorage();
          }
          handleFirestoreError(error, OperationType.GET, `board_cache/${config.boardId}`);
          return false;
        }
        
        if (cacheDoc.exists()) {
          const cachedData = cacheDoc.data();
          
          // Check if column IDs match
          const cachedColumnIds = cachedData.columnIds || [];
          const columnsMatch = columnIds.length === cachedColumnIds.length && 
                               columnIds.every(id => cachedColumnIds.includes(id));
                               
          if (columnsMatch || ignoreColumnMismatch) {
            let items = cachedData.items;
            
            // If items are stored in chunks, combine them
            if (cachedData.isChunked && cachedData.chunkCount) {
              const chunks = [items];
              for (let i = 1; i < cachedData.chunkCount; i++) {
                try {
                  const chunkDoc = await getDoc(doc(db, `board_cache_${config.boardId}_${i}`, "data"));
                  if (chunkDoc.exists()) {
                    chunks.push(chunkDoc.data().items);
                  }
                } catch (error) {
                  if (error instanceof Error && error.message.includes('resource-exhausted')) {
                    console.error(`Firestore Read Quota Exceeded for board_cache chunk ${i}`);
                    setQuotaExceeded(true);
                    // If we hit quota mid-chunks, we might have partial data. 
                    // It's better to stop and use what we have or just fail this cache load.
                    break; 
                  }
                  handleFirestoreError(error, OperationType.GET, `board_cache_${config.boardId}_${i}/data`);
                }
              }
              items = chunks.flat();
            }

            // Convert compact format back to MondayItem format if needed
            const formattedItems: MondayItem[] = items.map((item: any) => {
              if (item.column_values) return item; // Already in MondayItem format
              return {
                id: item.id || "",
                name: item.name || "",
                column_values: Object.entries(item.c || {}).map(([id, val]: [string, any]) => ({
                  id,
                  text: val.t || "",
                  value: val.v || null
                }))
              };
            });

            setMondayData(formattedItems);
            processData(formattedItems);
            setIsFromCache(true);
            setLastSyncedAt(new Date(cachedData.updatedAt || Date.now()));
            return true;
          }
        }
        return false;
      };

    try {
      // If we already have data (e.g. from localStorage) and we're not forcing a refresh, we're done
      if (mondayData.length > 0 && !force) {
        setLoading(false);
        return;
      }
      
      // If we don't have data in state, try localStorage first before Firestore
      if (mondayData.length === 0 && !force) {
        if (loadFromLocalStorage()) {
          setLoading(false);
          // We still might want to try Firestore in the background if not forced?
          // No, let's save quota. If the user wants fresh data they can click refresh.
          return;
        }
      }

      // Always try to load from persistent cache in Firestore first for speed
      const cacheLoaded = await loadFromCache(false);
      
      // If we loaded from cache and we're NOT forcing a refresh, we're done
      if (cacheLoaded && !force) {
        setLoading(false);
        return;
      }

      // If we are forcing a refresh (manual or 6 AM), we fetch from Monday.com
      // but we don't block the UI if we already have cached data
      if (cacheLoaded) {
        setLoading(false);
      }

      // Fetch from Monday.com
      setIsSyncing(true);
      const response = await fetchMondayData(config.boardId, columnIds, force, config.mondayApiKey);
      const items = response.data;
      
      setMondayData(items);
      processData(items);
      setIsFromCache(!!response.fromCache);
      
      const now = new Date().toISOString();
      setLastSyncedAt(new Date());
      
      // Update persistent cache - Use a compact format but store ALL items to support different date ranges
      // CRITICAL: Only admins should write to Firestore to save quota.
      // Also skip if we already hit a write quota error.
      if (userRole === "admin" && auth.currentUser && !response.fromCache && !writeQuotaExceeded && !isWritingRef.current) {
        isWritingRef.current = true;
        
        try {
          // 1. Save the processed data for the FULL YEAR as the materialized view
          // We need to calculate this specifically for the full year to ensure the "instant load" is complete
          const fullYearData = calculateProcessedData(items, config, goals, { start: "2026-01-01", end: "2026-12-31" });
          
          try {
            await setDoc(doc(db, "dashboard_data", "2026"), {
              ...fullYearData,
              lastSyncedAt: now
            });
          } catch (err: any) {
            if (err.code === 'resource-exhausted' || (err.message && err.message.includes('resource-exhausted'))) {
              setWriteQuotaExceeded(true);
            } else if (err.code !== 'permission-denied') {
              handleFirestoreError(err, OperationType.WRITE, "dashboard_data/2026");
            }
          }

          if (writeQuotaExceeded) {
            isWritingRef.current = false;
            return;
          }

          const filteredItems = items.map(item => {
            const filteredCols: Record<string, { t: string; v: string | null }> = {};
            item.column_values.forEach(cv => {
              filteredCols[cv.id] = { t: cv.text, v: cv.value || null };
            });
            return { id: item.id, name: item.name, c: filteredCols };
          });

          // If still very large, we might need to chunk it, but for now let's try to save it
          // Firestore limit is 1MB. Let's check size roughly.
          const dataStr = JSON.stringify(filteredItems);
          const sizeInBytes = new TextEncoder().encode(dataStr).length;
          
          if (sizeInBytes < 900000) {
            try {
              await setDoc(doc(db, "board_cache", config.boardId), { 
                items: filteredItems, 
                updatedAt: now,
                isChunked: false,
                columnIds: columnIds
              });
            } catch (error: any) {
              if (error.code === 'resource-exhausted' || (error.message && error.message.includes('resource-exhausted'))) {
                setWriteQuotaExceeded(true);
              } else {
                handleFirestoreError(error, OperationType.WRITE, `board_cache/${config.boardId}`);
              }
            }
          } else {
            // Chunking logic
            const chunkSize = Math.ceil(filteredItems.length / Math.ceil(sizeInBytes / 800000));
            const chunks = [];
            for (let i = 0; i < filteredItems.length; i += chunkSize) {
              chunks.push(filteredItems.slice(i, i + chunkSize));
            }
            
            // Save first chunk in main doc
            try {
              await setDoc(doc(db, "board_cache", config.boardId), { 
                items: chunks[0], 
                updatedAt: now,
                isChunked: true,
                chunkCount: chunks.length,
                columnIds: columnIds
              });
            } catch (error: any) {
              if (error.code === 'resource-exhausted' || (error.message && error.message.includes('resource-exhausted'))) {
                setWriteQuotaExceeded(true);
              } else {
                handleFirestoreError(error, OperationType.WRITE, `board_cache/${config.boardId}`);
              }
            }
            
            // Save subsequent chunks in separate docs
            if (!writeQuotaExceeded) {
              for (let i = 1; i < chunks.length; i++) {
                if (writeQuotaExceeded) break;
                try {
                  // Add a small delay between chunk writes to avoid "Write stream exhausted"
                  await new Promise(resolve => setTimeout(resolve, 200));
                  
                  await setDoc(doc(db, `board_cache_${config.boardId}_${i}`, "data"), {
                    items: chunks[i]
                  });
                } catch (error: any) {
                  if (error.code === 'resource-exhausted' || (error.message && error.message.includes('resource-exhausted'))) {
                    setWriteQuotaExceeded(true);
                    break;
                  } else {
                    handleFirestoreError(error, OperationType.WRITE, `board_cache_${config.boardId}_${i}/data`);
                  }
                }
              }
            }
          }
          
          // Update config with last refresh time
          if (!writeQuotaExceeded) {
            const newConfig = { ...config, lastRefreshAt: now };
            try {
              await setDoc(doc(db, "config", "main"), newConfig);
              setConfig(newConfig);
            } catch (error: any) {
              if (error.code === 'resource-exhausted' || (error.message && error.message.includes('resource-exhausted'))) {
                setWriteQuotaExceeded(true);
              } else {
                handleFirestoreError(error, OperationType.WRITE, "config/main");
              }
            }
          }
        } catch (cacheErr) {
          console.warn("Failed to update persistent cache:", cacheErr);
        } finally {
          isWritingRef.current = false;
        }
      } else {
        // If not authenticated or not admin, just update local state
        if (!response.fromCache) {
          setConfig({ ...config, lastRefreshAt: now });
        }
      }
      
      setError(null);
    } catch (err) {
      if (err instanceof Error && err.message.includes('FirestoreErrorInfo')) {
        throw err;
      }
      console.error("Failed to fetch Monday data:", err);
      
      // Fallback to Firebase cache if we haven't already loaded it
      const loadedFromCache = await loadFromCache(true);
      if (loadedFromCache) {
        setError("Failed to fetch fresh data from Monday.com. Showing cached data from Firebase.");
      } else {
        setError("Failed to fetch data from Monday.com and no cached data found in Firebase.");
      }
    } finally {
      setLoading(false);
      setIsSyncing(false);
    }
  }, [config, processData, dateRange.start, dateRange.end, userRole, processedData.monthlySales.length]);

  useEffect(() => {
    if (!config.boardId) return;
    // On load or config change, check if we need to force a refresh based on schedule
    const shouldForce = checkScheduledRefresh();
    
    if (shouldForce) {
      // Add a random delay for scheduled refreshes to avoid race conditions 
      // where multiple clients all try to refresh and write at the same time
      const delay = Math.random() * 10000; // 0-10 seconds
      const timer = setTimeout(() => fetchData(true), delay);
      return () => clearTimeout(timer);
    } else {
      fetchData(false);
    }
  }, [config.boardId, config.salesAmountColumnId, config.soldDateColumnId, config.initialContactDateColumnId, config.salesRepColumnId, config.quoteStatusColumnId]);

  // Timer for scheduled refreshes while the app is open
  useEffect(() => {
    const timer = setInterval(() => {
      if (checkScheduledRefresh() && !loading && config.boardId) {
        console.log("Triggering scheduled data refresh...");
        fetchData(true);
      }
    }, 60000); // Check every minute
    return () => clearInterval(timer);
  }, [checkScheduledRefresh, loading, config.boardId, fetchData]);

  const handleRefresh = () => fetchData(true);

  const handleSaveGoals = async () => {
    try {
      const currentYear = "2026";
      await setDoc(doc(db, "goals", currentYear), { ...goals, year: 2026 });
      setIsEditingGoals(false);
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `goals/2026`);
    }
  };

  const handleSaveConfig = async () => {
    try {
      await setDoc(doc(db, "config", "main"), config);
      setIsConfiguringBoard(false);
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, "config/main");
    }
  };

  const progress = ((processedData?.data2026?.totalSales || 0) / goals.companyAnnualGoal) * 100;

  if (loading && config.boardId && processedData.monthlySales.length === 0) {
    return (
      <div className="h-screen bg-brand-black flex flex-col items-center justify-center p-10">
        <RefreshCw className="w-12 h-12 text-brand-gold animate-spin mb-4" />
        <p className="text-brand-gray-mid font-medium text-xl">Loading TV Dashboard...</p>
      </div>
    );
  }

  return (
    <div className="h-screen bg-brand-black text-brand-cream font-sans flex flex-col overflow-hidden">
      {/* Header - Removed title as requested */}
      <div className="h-4 bg-brand-gold flex-shrink-0" />

      {/* Main Content Area */}
      <main className="flex-1 p-4 flex flex-col gap-4 overflow-hidden">
        {error && (
          <div className="p-3 bg-rose-900/30 border border-rose-900/50 rounded-xl flex items-center gap-3 text-rose-200 flex-shrink-0">
            <AlertCircle className="w-5 h-5" />
            <p className="text-sm font-medium">{error}</p>
          </div>
        )}

        {/* Top Section: Sales Reps Leaderboard (Vertical Bar Graph) */}
        <div className="bg-brand-charcoal p-4 rounded-[2.5rem] shadow-2xl border border-white/5 flex flex-col h-[44%]">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-2xl font-black text-white flex items-center gap-4 uppercase tracking-[0.1em]">
              <Users className="w-8 h-8 text-brand-gold" />
              Sales Representative Performance
            </h3>
            <div className="flex items-center gap-6">
              <div className="flex items-center gap-3">
                <div className="w-4 h-4 rounded-full bg-brand-green" />
                <span className="text-xs font-black text-brand-gray-mid uppercase tracking-widest">2026 Sales</span>
              </div>
            </div>
          </div>
          <div className="flex-1 min-h-0">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart 
                data={paginatedSales} 
                margin={{ top: 60, right: 30, left: 20, bottom: 20 }}
              >
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#ffffff08" />
                <XAxis 
                  dataKey="name" 
                  axisLine={false} 
                  tickLine={false} 
                  tick={{fill: BRAND_COLORS.grayMid, fontSize: 18, fontWeight: 900}}
                  interval={0}
                />
                <YAxis hide />
                <Tooltip 
                  cursor={{fill: '#ffffff03'}}
                  contentStyle={{ backgroundColor: BRAND_COLORS.black, border: '1px solid #ffffff10', borderRadius: '16px', color: '#fff' }}
                  itemStyle={{ fontSize: '14px', fontWeight: 'bold' }}
                  formatter={(val: number) => [`$${Math.round(val).toLocaleString()}`, 'Amount']}
                />
                <Bar dataKey="sales" fill={BRAND_COLORS.gold} radius={[12, 12, 0, 0]} barSize={100}>
                  <LabelList 
                    dataKey="sales" 
                    position="top" 
                    formatter={(val: number) => formatValue(val)}
                    style={{ fill: BRAND_COLORS.green, fontSize: 22, fontWeight: '900' }}
                    offset={15}
                  />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Middle Section: Comparison Stats (Grid) */}
        <div className="grid grid-cols-7 gap-4 h-[16%]">
          <ComparisonStatCard 
            title="Total Sales" 
            val2026={formatNumber(processedData?.data2026?.totalSales || 0)}
            val2025={formatNumber(processedData?.data2025?.totalSales || 0)}
            icon={<DollarSign className="w-8 h-8 text-brand-gold" />}
            progress={progress}
          />
          <ComparisonStatCard 
            title="Sales This Month" 
            val2026={formatNumber(processedData?.data2026?.currentMonthSales || 0)}
            val2025={formatNumber(processedData?.data2025?.currentMonthSales || 0)}
            icon={<Calendar className="w-8 h-8 text-brand-gold" />}
          />
          <ComparisonStatCard 
            title="Jobs Sold" 
            val2026={(processedData?.data2026?.totalClosed || 0).toString()}
            val2025={(processedData?.data2025?.totalClosed || 0).toString()}
            icon={<Briefcase className="w-8 h-8 text-brand-gold" />}
          />
          <GoalWidget 
            current={processedData?.data2026?.totalSales || 0} 
            goal={16001374} 
            icon={<Flag className="w-8 h-8 text-brand-gold" />}
          />
          <ComparisonStatCard 
            title="Avg Sale" 
            val2026={formatNumber(processedData?.data2026?.averageSale || 0)}
            val2025={formatNumber(processedData?.data2025?.averageSale || 0)}
            icon={<TrendingUp className="w-8 h-8 text-brand-gold" />}
          />
          <ComparisonStatCard 
            title="Close Ratio (Quoted)" 
            val2026={`${(processedData?.data2026?.totalQuoted || 0) > 0 ? Math.floor(((processedData?.data2026?.totalClosed || 0) / (processedData?.data2026?.totalQuoted || 1)) * 1000) / 10 : 0}%`}
            val2025={`${(processedData?.data2025?.totalQuoted || 0) > 0 ? Math.floor(((processedData?.data2025?.totalClosed || 0) / (processedData?.data2025?.totalQuoted || 1)) * 1000) / 10 : 0}%`}
            icon={<Target className="w-8 h-8 text-brand-gold" />}
          />
          <ComparisonStatCard 
            title="Close Ratio (Leads)" 
            val2026={`${(processedData?.data2026?.totalLeads || 0) > 0 ? Math.floor(((processedData?.data2026?.totalClosed || 0) / (processedData?.data2026?.totalLeads || 1)) * 1000) / 10 : 0}%`}
            val2025={`${(processedData?.data2025?.totalLeads || 0) > 0 ? Math.floor(((processedData?.data2025?.totalClosed || 0) / (processedData?.data2025?.totalLeads || 1)) * 1000) / 10 : 0}%`}
            icon={<Users className="w-8 h-8 text-brand-gold" />}
          />
        </div>

        {/* Bottom Section: Monthly Trend & Table */}
        <div className="flex-1 flex gap-4 min-h-0">
          {/* Left: Monthly Sales Comparison (Line Graph) */}
          <div className="flex-[1.5] bg-brand-charcoal p-4 rounded-[2.5rem] shadow-xl border border-white/5 flex flex-col min-h-0">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xl font-black text-white flex items-center gap-4 uppercase tracking-wider">
                <BarChart3 className="w-8 h-8 text-brand-gold" />
                Monthly Sales Trend
              </h3>
              <div className="flex items-center gap-8">
                <div className="flex items-center gap-3">
                  <div className="w-4 h-4 rounded-full bg-brand-green" />
                  <span className="text-xs font-black text-brand-gray-mid uppercase tracking-widest">2026</span>
                </div>
                <div className="flex items-center gap-3">
                  <div className="w-4 h-4 rounded-full bg-brand-orange" />
                  <span className="text-xs font-black text-brand-gray-mid uppercase tracking-widest">2025</span>
                </div>
              </div>
            </div>
            <div className="flex-1 min-h-0">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={processedData.monthlySales} margin={{ top: 30, right: 40, left: 30, bottom: 10 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#ffffff08" />
                  <XAxis 
                    dataKey="name" 
                    axisLine={false} 
                    tickLine={false} 
                    tick={{fill: BRAND_COLORS.grayMid, fontSize: 14, fontWeight: 700}} 
                    interval={0}
                    padding={{ left: 10, right: 10 }}
                  />
                  <YAxis hide />
                  <Tooltip 
                    contentStyle={{ backgroundColor: BRAND_COLORS.black, border: '1px solid #ffffff10', borderRadius: '16px', color: '#fff' }}
                    itemStyle={{ fontSize: '14px', fontWeight: 'bold' }}
                    formatter={(val: number) => [`$${Math.round(val).toLocaleString()}`, 'Sales']}
                  />
                  <Line 
                    type="monotone" 
                    dataKey="sales2026" 
                    stroke={BRAND_COLORS.green} 
                    strokeWidth={6} 
                    dot={{ r: 8, fill: BRAND_COLORS.green, strokeWidth: 3, stroke: BRAND_COLORS.black }}
                    activeDot={{ r: 10 }}
                  >
                    <LabelList 
                      dataKey="sales2026" 
                      position="top" 
                      formatter={(val: number) => formatCompact(val)}
                      style={{ fill: BRAND_COLORS.green, fontSize: 14, fontWeight: '900' }}
                      offset={15}
                    />
                  </Line>
                  <Line 
                    type="monotone" 
                    dataKey="sales2025" 
                    stroke={BRAND_COLORS.orange} 
                    strokeWidth={6} 
                    dot={{ r: 8, fill: BRAND_COLORS.orange, strokeWidth: 3, stroke: BRAND_COLORS.black }}
                    activeDot={{ r: 10 }}
                  >
                    <LabelList 
                      dataKey="sales2025" 
                      position="bottom" 
                      formatter={(val: number) => formatCompact(val)}
                      style={{ fill: BRAND_COLORS.orange, fontSize: 14, fontWeight: '900' }}
                      offset={15}
                    />
                  </Line>
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Right: Per Month Job Value (Table) */}
          <div className="flex-1 bg-brand-charcoal p-4 rounded-[2.5rem] shadow-xl border border-white/5 flex flex-col min-h-0">
            <h3 className="text-xl font-black text-white mb-4 uppercase tracking-wider">
              Monthly Sales Comparison
            </h3>
            <div className="flex-1 overflow-hidden rounded-3xl border border-white/5">
              <table className="w-full h-full text-left border-collapse">
                <thead>
                  <tr className="bg-brand-black/50">
                    <th className="py-2 px-4 text-[10px] font-black text-brand-gray-mid uppercase tracking-[0.2em] border-b border-white/5">Month</th>
                    <th className="py-2 px-4 text-[10px] font-black text-brand-green uppercase tracking-[0.2em] border-b border-white/5 text-center bg-brand-green/5">2026</th>
                    <th className="py-2 px-4 text-[10px] font-black text-brand-orange uppercase tracking-[0.2em] border-b border-white/5 text-center">2025</th>
                  </tr>
                </thead>
                <tbody className="bg-brand-charcoal/30">
                  {paginatedMonths.map((m, idx) => (
                    <tr key={m.name} className={cn(
                      "border-b border-white/5 last:border-0",
                      idx % 2 === 0 ? "bg-white/2" : ""
                    )}>
                      <td className="py-2 px-4 text-xs font-black text-brand-gray-light">{m.name}</td>
                      <td className="py-2 px-4 text-sm font-black text-brand-green text-center bg-brand-green/10 border-x border-white/5">
                        {formatValue(m.sales2026)}
                      </td>
                      <td className="py-2 px-4 text-sm font-black text-brand-orange/80 text-center">
                        {formatValue(m.sales2025)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

function GoalWidget({ current, goal, icon }: { current: number; goal: number; icon: React.ReactNode }) {
  const percentage = (current / goal) * 100;
  return (
    <div className="bg-brand-charcoal p-4 rounded-3xl shadow-sm border border-white/5 flex items-center gap-4">
      <div className="bg-brand-black p-3 rounded-2xl flex-shrink-0">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex justify-between items-center mb-1">
          <p className="text-[10px] font-bold text-brand-gray-mid uppercase tracking-widest truncate">2026 Annual Goal</p>
          <span className="text-[10px] font-black text-brand-gold">{Math.round(percentage)}%</span>
        </div>
        <div className="space-y-1">
          <div className="flex justify-between items-end">
            <span className="text-[10px] font-bold text-brand-gray-mid">Current</span>
            <span className="text-sm font-black text-brand-green">${Math.round(current).toLocaleString()}</span>
          </div>
          <div className="w-full bg-brand-black h-1.5 rounded-full overflow-hidden">
            <div 
              className="h-full bg-brand-gold rounded-full transition-all duration-1000" 
              style={{ width: `${Math.min(percentage, 100)}%` }}
            />
          </div>
          <div className="flex justify-between items-start">
            <span className="text-[9px] font-bold text-brand-gray-mid">Goal</span>
            <span className="text-[9px] font-bold text-brand-gray-mid">${goal.toLocaleString()}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function ComparisonStatCard({ title, val2026, val2025, icon, progress }: { 
  title: string; 
  val2026: string; 
  val2025: string; 
  icon: React.ReactNode;
  progress?: number;
}) {
  return (
    <div className="bg-brand-charcoal p-4 rounded-3xl shadow-sm border border-white/5 flex items-center gap-4">
      <div className="bg-brand-black p-3 rounded-2xl flex-shrink-0">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex justify-between items-center mb-1">
          <p className="text-[10px] font-bold text-brand-gray-mid uppercase tracking-widest truncate">{title}</p>
          {progress !== undefined && (
            <div className="text-[9px] font-black px-2 py-0.5 rounded-full bg-brand-gold/10 text-brand-gold border border-brand-gold/20">
              {Math.round(progress)}%
            </div>
          )}
        </div>
        <div className="space-y-1">
          <div className="flex items-end justify-between">
            <span className="text-[10px] font-bold text-brand-gray-mid">2026</span>
            <h4 className="text-xl font-black text-brand-green leading-none">{val2026}</h4>
          </div>
          <div className="flex items-end justify-between pt-1 border-t border-white/5">
            <span className="text-[9px] font-bold text-brand-gray-mid">2025</span>
            <span className="text-sm font-bold text-brand-orange/80">{val2025}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatCard({ title, value, subValue, icon, trend, progress, compact }: { 
  title: string; 
  value: string; 
  subValue: string; 
  icon: React.ReactNode;
  trend?: "up" | "down";
  progress?: number;
  compact?: boolean;
}) {
  return (
    <div className={cn(
      "bg-brand-charcoal rounded-3xl shadow-sm border border-white/5 flex flex-col justify-between",
      compact ? "p-4" : "p-6"
    )}>
      <div className={cn("flex justify-between items-start", compact ? "mb-2" : "mb-4")}>
        <div className={cn("bg-brand-black rounded-2xl", compact ? "p-1.5" : "p-3")}>
          {icon}
        </div>
        {trend && !compact && (
          <div className={cn(
            "flex items-center gap-1 text-xs font-bold px-2 py-1 rounded-full",
            trend === "up" ? "bg-brand-green/10 text-brand-green" : "bg-rose-900/10 text-rose-400"
          )}>
            {trend === "up" ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
          </div>
        )}
      </div>
      <div>
        <p className={cn("font-medium", compact ? "text-[10px] text-brand-gray-mid uppercase tracking-wider" : "text-sm text-brand-gray-mid mb-1")}>{title}</p>
        <h4 className={cn("font-bold text-white", compact ? "text-lg" : "text-2xl")}>{value}</h4>
        <p className={cn("text-brand-gray-mid", compact ? "text-[9px]" : "text-xs mt-1")}>{subValue}</p>
      </div>
      {progress !== undefined && (
        <div className={cn("w-full bg-brand-black rounded-full overflow-hidden", compact ? "h-1 mt-2" : "mt-4 h-1.5")}>
          <div 
            className="h-full bg-brand-gold rounded-full transition-all duration-1000" 
            style={{ width: `${Math.min(progress, 100)}%` }}
          />
        </div>
      )}
    </div>
  );
}
