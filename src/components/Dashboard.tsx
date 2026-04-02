import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { 
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, 
  LineChart, Line, PieChart, Pie, Cell, AreaChart, Area, LabelList 
} from "recharts";
import { 
  TrendingUp, Users, DollarSign, Target, 
  BarChart3, PieChart as PieChartIcon, 
  ArrowUpRight, ArrowDownRight, Calendar,
  FileText, CheckCircle2, Clock, Edit2, Save, X, Settings, RefreshCw, AlertCircle, Briefcase, LogIn, LogOut
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

const COLORS = ["#10b981", "#3b82f6", "#f59e0b", "#ef4444", "#8b5cf6"];

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

    // Parse Amount - prefer 'value' for numbers columns
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
    
    // Parse Dates - prefer 'value' for date columns (it's YYYY-MM-DD)
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
    
    // Ensure dates are in YYYY-MM-DD format
    const normalizeDate = (d: string) => {
      if (!d) return "";
      
      // If it's already YYYY-MM-DD or YYYY-M-D
      if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(d)) {
        const parts = d.split('-');
        return `${parts[0]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`;
      }

      // Handle MM/DD/YYYY or DD/MM/YYYY
      if (d.includes('/')) {
        const parts = d.split('/');
        if (parts.length === 3) {
          const p0 = parts[0].padStart(2, '0');
          const p1 = parts[1].padStart(2, '0');
          const p2 = parts[2];

          if (p2.length === 4) {
            // If p0 > 12, it must be DD/MM/YYYY
            if (parseInt(p0) > 12) {
              return `${p2}-${p1}-${p0}`;
            }
            // Otherwise assume MM/DD/YYYY (standard Monday.com export)
            return `${p2}-${p0}-${p1}`;
          }
        }
      }
      
      // Try native Date parsing as last resort
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

    // Check if the status is actually "Sold" or "Closed" to avoid counting leads with dates
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

    // Only add to available reps if they have activity in the current date range (same as widget)
    if (primaryRep !== "Unknown" && (isInitialContactInRange || (isSoldInRange && isActuallySold))) {
      uniqueReps.add(primaryRep);
    }

    // Now apply the filter for the rest of the calculations
    if (config.includedSalesReps && config.includedSalesReps.length > 0) {
      if (!config.includedSalesReps.includes(primaryRep)) {
        stats.ignored++;
        return; // Skip this item
      }
    }

    if (isSoldInRange || isInitialContactInRange) {
      stats.inRange++;
    } else {
      stats.ignored++;
    }

    if (isActuallySold) stats.isSold++;

    // Total Sales, Jobs Sold, Average Sale, Sales by Person
    if (isSoldInRange && isActuallySold) {
      totalSales += amount;
      totalJobsSold += 1;

      // Monthly Sales (for chart)
      const dateParts = sDate.split('-');
      if (dateParts.length === 3) {
        const monthIndex = parseInt(dateParts[1]) - 1;
        const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        const month = months[monthIndex];
        monthlySalesMap[month] = (monthlySalesMap[month] || 0) + amount;
      }

      // Individual Sales - use the first rep if multiple are assigned to keep count consistent
      if (!individualSalesMap[primaryRep]) {
        individualSalesMap[primaryRep] = { sales: 0, quotes: 0, closed: 0 };
      }
      individualSalesMap[primaryRep].sales += amount;
      individualSalesMap[primaryRep].closed += 1;
    }

    // Close Ratio (total leads)
    if (isInitialContactInRange || (isSoldInRange && isActuallySold)) {
      totalLeads += 1;
      
      if (!individualSalesMap[primaryRep]) {
        individualSalesMap[primaryRep] = { sales: 0, quotes: 0, closed: 0 };
      }
      individualSalesMap[primaryRep].quotes += 1;
    }
  });

  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const monthlySales = months.map(m => ({
    name: m,
    sales: monthlySalesMap[m] || 0,
    goal: Math.floor(goals.companyAnnualGoal / 12)
  }));

  const individualSales = Object.entries(individualSalesMap).map(([name, stats]) => ({
    name,
    ...stats,
    goal: goals.individualAnnualGoal
  })).sort((a, b) => b.sales - a.sales);

  return {
    monthlySales,
    individualSales,
    totalSales,
    totalQuotes: totalLeads,
    totalClosed: totalJobsSold,
    totalLeads,
    averageSale: totalJobsSold > 0 ? totalSales / totalJobsSold : 0,
    stats,
    uniqueReps: Array.from(uniqueReps).sort()
  };
};

export default function Dashboard({ userRole, user, onLogout }: DashboardProps) {
  const [isEditingGoals, setIsEditingGoals] = useState(false);
  const [isConfiguringBoard, setIsConfiguringBoard] = useState(false);
  const [loading, setLoading] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
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

  const [dateRange, setDateRange] = useState<{ start: string; end: string }>({
    start: "2026-01-01",
    end: "2026-12-31"
  });

  const [availableBoards, setAvailableBoards] = useState<{ id: string; name: string }[]>([]);
  const [availableColumns, setAvailableColumns] = useState<{ id: string; title: string; type: string }[]>([]);
  const [mondayData, setMondayData] = useState<MondayItem[]>([]);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);

  const [processedData, setProcessedData] = useState<{
    monthlySales: any[];
    individualSales: any[];
    totalSales: number;
    totalQuotes: number;
    totalClosed: number;
    totalLeads: number;
    averageSale: number;
    stats?: {
      totalFetched: number;
      inRange: number;
      isSold: number;
      ignored: number;
    };
  }>({
    monthlySales: [],
    individualSales: [],
    totalSales: 0,
    totalQuotes: 0,
    totalClosed: 0,
    totalLeads: 0,
    averageSale: 0,
    stats: {
      totalFetched: 0,
      inRange: 0,
      isSold: 0,
      ignored: 0
    }
  });

  const [currentSalesPage, setCurrentSalesPage] = useState(0);
  const itemsPerPage = 5;

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
    }, 10000); // 10 seconds per slide

    return () => clearInterval(interval);
  }, [processedData.individualSales.length]);

  const paginatedSales = processedData.individualSales.slice(
    currentSalesPage * itemsPerPage,
    (currentSalesPage + 1) * itemsPerPage
  );

  const [quotaExceeded, setQuotaExceeded] = useState(false);
  const [writeQuotaExceeded, setWriteQuotaExceeded] = useState(false);
  const isWritingRef = useRef(false);

  // Listen for Dashboard Data (Materialized View)
  useEffect(() => {
    const currentYear = "2026";
    
    // Try to load from localStorage first
    const cachedData = localStorage.getItem(`dashboard_data_${currentYear}`);
    if (cachedData) {
      try {
        const data = JSON.parse(cachedData);
        setProcessedData(data);
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
        const newData = {
          monthlySales: data.monthlySales || [],
          individualSales: data.individualSales || [],
          totalSales: data.totalSales || 0,
          totalQuotes: data.totalQuotes || 0,
          totalClosed: data.totalClosed || 0,
          totalLeads: data.totalLeads || 0,
          averageSale: data.averageSale || 0,
          stats: data.stats,
          lastSyncedAt: data.lastSyncedAt
        };
        setProcessedData(newData);
        localStorage.setItem(`dashboard_data_${currentYear}`, JSON.stringify(newData));
        
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

  // Process Monday.com Data
  const processData = useCallback((items: MondayItem[]) => {
    if (!config.boardId) return;

    const result = calculateProcessedData(items, config, goals, dateRange);

    setAvailableSalesReps(result.uniqueReps);
    setProcessedData({
      monthlySales: result.monthlySales,
      individualSales: result.individualSales,
      totalSales: result.totalSales,
      totalQuotes: result.totalQuotes,
      totalClosed: result.totalClosed,
      totalLeads: result.totalLeads,
      averageSale: result.averageSale,
      stats: result.stats
    });
  }, [config, goals, dateRange, userRole]);

  // Re-process data when dependencies change
  useEffect(() => {
    if (mondayData.length > 0) {
      processData(mondayData);
    }
  }, [mondayData, processData]);

  const [isFromCache, setIsFromCache] = useState(false);

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

  const progress = (processedData.totalSales / goals.companyAnnualGoal) * 100;
  const closeRatio = processedData.totalQuotes > 0 ? (processedData.totalClosed / processedData.totalQuotes) * 100 : 0;

  if (loading && config.boardId && processedData.monthlySales.length === 0) {
    return (
      <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center p-10">
        <RefreshCw className="w-12 h-12 text-blue-500 animate-spin mb-4" />
        <p className="text-slate-400 font-medium">Fetching Calgary Sales Data...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen lg:h-screen bg-slate-950 text-slate-100 font-sans flex flex-col overflow-x-hidden lg:overflow-hidden">
      {/* Header */}
      <header className="bg-slate-900 border-b border-slate-800 px-4 md:px-8 py-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4 flex-shrink-0">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold text-white tracking-tight">Calgary Office Dashboard</h1>
          <p className="text-slate-400 mt-1 text-sm md:text-base">Sales Performance & Goals Tracking (2026)</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 md:gap-4">
          {/* Sync Status */}
          <div className="flex flex-col items-start lg:items-end mr-2">
            {isSyncing ? (
              <div className="flex items-center gap-1.5 text-xs font-bold text-blue-400 uppercase tracking-wider">
                <RefreshCw className="w-3 h-3 animate-spin" />
                Syncing Monday API...
              </div>
            ) : (
              <div className="flex items-center gap-1.5 text-xs font-bold text-emerald-500 uppercase tracking-wider">
                <div className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse" />
                {isFromCache ? "Cached Data" : "Live Data"}
              </div>
            )}
            <span className="text-[10px] text-slate-500">
              Last Refresh: {config.lastRefreshAt ? new Date(config.lastRefreshAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Never'}
            </span>
            {/* Added Stats for Debugging */}
            <div className="flex gap-2 mt-1">
              <span className="text-[9px] text-slate-400 bg-slate-800/50 px-1.5 py-0.5 rounded border border-slate-700/50">Fetched: {processedData.stats?.totalFetched || 0}</span>
              <span className="text-[9px] text-slate-400 bg-slate-800/50 px-1.5 py-0.5 rounded border border-slate-700/50">2026: {processedData.stats?.inRange || 0}</span>
              <span className="text-[9px] text-emerald-400/70 bg-emerald-900/20 px-1.5 py-0.5 rounded border border-emerald-800/30">Sold: {processedData.stats?.isSold || 0}</span>
            </div>
          </div>

          <button 
            onClick={handleRefresh}
            disabled={loading || !config.boardId}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-xl text-sm font-bold hover:bg-blue-700 transition-all shadow-lg shadow-blue-600/20 disabled:opacity-50"
          >
            <RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} />
            Sync Data Now
          </button>
          {userRole === "admin" && (
            <>
              <button 
                onClick={() => setIsConfiguringBoard(!isConfiguringBoard)}
                className="flex items-center gap-2 px-4 py-2 bg-slate-800 border border-slate-700 rounded-xl text-sm font-semibold text-slate-200 hover:bg-slate-700 transition-all shadow-sm"
              >
                <Settings className="w-4 h-4" />
                Board Config
              </button>
              <button 
                onClick={() => setIsEditingGoals(!isEditingGoals)}
                className="flex items-center gap-2 px-4 py-2 bg-slate-800 border border-slate-700 rounded-xl text-sm font-semibold text-slate-200 hover:bg-slate-700 transition-all shadow-sm"
              >
                {isEditingGoals ? <X className="w-4 h-4" /> : <Edit2 className="w-4 h-4" />}
                {isEditingGoals ? "Cancel" : "Edit Goals"}
              </button>
            </>
          )}
          <div className="flex items-center gap-3 bg-slate-800 p-2 rounded-xl shadow-sm border border-slate-700">
            <Calendar className="w-5 h-5 text-slate-500" />
            <span className="text-sm font-medium text-slate-200">
              2026
            </span>
          </div>
          <button 
            onClick={onLogout}
            className="flex items-center gap-2 px-3 py-2 bg-slate-800 border border-slate-700 rounded-xl text-sm font-semibold text-slate-200 hover:bg-slate-700 transition-all shadow-sm"
            title="Sign Out"
          >
            <LogOut className="w-4 h-4" />
            <span className="hidden md:inline">Sign Out</span>
          </button>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 p-4 md:p-6 flex flex-col gap-6 overflow-y-auto lg:overflow-hidden">
        {quotaExceeded && (
          <div className="p-3 bg-amber-900/30 border border-amber-900/50 rounded-xl flex items-center gap-3 text-amber-200 flex-shrink-0">
            <AlertCircle className="w-5 h-5" />
            <p className="text-sm font-medium">Firestore Read Quota Exceeded. Displaying cached data from your browser. Live updates are temporarily disabled.</p>
          </div>
        )}

        {writeQuotaExceeded && (
          <div className="p-3 bg-rose-900/30 border border-rose-900/50 rounded-xl flex items-center gap-3 text-rose-200 flex-shrink-0">
            <AlertCircle className="w-5 h-5" />
            <p className="text-sm font-medium">Firestore Write Quota Exceeded. Changes cannot be saved to the shared database until the quota resets. Local data is still available.</p>
          </div>
        )}

        {error && (
          <div className="p-3 bg-rose-900/30 border border-rose-900/50 rounded-xl flex items-center gap-3 text-rose-200 flex-shrink-0">
            <AlertCircle className="w-5 h-5" />
            <p className="text-sm font-medium">{error}</p>
          </div>
        )}

        {/* Board Config Editor (Admin Only) */}
        {isConfiguringBoard && userRole === "admin" && (
          <div className="fixed inset-0 z-[100] bg-slate-950/95 backdrop-blur-sm p-4 md:p-8 flex items-center justify-center">
            <div className="bg-slate-900 w-full max-w-4xl max-h-[90vh] overflow-y-auto rounded-2xl md:rounded-3xl shadow-2xl border border-slate-800 p-6 md:p-10">
              <div className="flex items-center justify-between mb-6 md:mb-8">
                <div>
                  <h3 className="text-xl md:text-2xl font-bold text-white flex items-center gap-3">
                    <Settings className="w-6 h-6 md:w-8 md:h-8 text-blue-400" />
                    Monday.com Integration
                  </h3>
                  <p className="text-slate-400 mt-1 text-xs md:text-sm">Map your Calgary (Main) board columns to dashboard metrics</p>
                </div>
                <button 
                  onClick={() => setIsConfiguringBoard(false)}
                  className="p-2 hover:bg-slate-800 rounded-full transition-colors"
                >
                  <X className="w-6 h-6 md:w-8 md:h-8 text-slate-500" />
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                {/* Board Selection & API Key */}
                <div className="space-y-6 p-6 bg-slate-800/50 rounded-2xl border border-slate-700/50">
                  <div className="space-y-2">
                    <label className="text-sm font-bold text-slate-400 uppercase tracking-widest">Monday.com API Key (Optional)</label>
                    <input 
                      type="password"
                      value={config.mondayApiKey ?? ""}
                      onChange={(e) => setConfig({...config, mondayApiKey: e.target.value})}
                      className="w-full p-4 bg-slate-900 text-white border border-slate-700 rounded-xl outline-none focus:ring-2 focus:ring-blue-500 transition-all"
                      placeholder="Leave blank to use server default"
                    />
                    <p className="text-[10px] text-slate-500 italic">Enter your personal API key if you want to override the system default.</p>
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-bold text-slate-400 uppercase tracking-widest">Source Board</label>
                    <select 
                      value={config.boardId}
                      onChange={(e) => setConfig({...config, boardId: e.target.value})}
                      className="w-full p-4 bg-slate-900 text-white border border-slate-700 rounded-xl outline-none focus:ring-2 focus:ring-blue-500 transition-all appearance-none cursor-pointer"
                    >
                      <option value="">-- Select a Board --</option>
                      {availableBoards.map(b => (
                        <option key={b.id} value={b.id}>{b.name}</option>
                      ))}
                    </select>
                  </div>
                </div>

                {config.boardId && (
                  <div className="space-y-6">
                    <div className="grid grid-cols-1 gap-6">
                      {/* Sales Amount */}
                      <div className="space-y-2">
                        <label className="text-xs font-bold text-slate-400 uppercase tracking-wider">Sales Amount ($)</label>
                        <select 
                          value={config.salesAmountColumnId}
                          onChange={(e) => setConfig({...config, salesAmountColumnId: e.target.value})}
                          className="w-full p-3 bg-slate-800 text-white border border-slate-700 rounded-xl outline-none focus:ring-2 focus:ring-blue-500 transition-all"
                        >
                          <option value="">-- Select Column --</option>
                          {availableColumns.filter(c => c.type === "numeric" || c.type === "numbers").map(c => (
                            <option key={c.id} value={c.id}>{c.title}</option>
                          ))}
                        </select>
                      </div>

                      {/* Sold(date) */}
                      <div className="space-y-2">
                        <label className="text-xs font-bold text-slate-400 uppercase tracking-wider">Sold(date)</label>
                        <select 
                          value={config.soldDateColumnId}
                          onChange={(e) => setConfig({...config, soldDateColumnId: e.target.value})}
                          className="w-full p-3 bg-slate-800 text-white border border-slate-700 rounded-xl outline-none focus:ring-2 focus:ring-blue-500 transition-all"
                        >
                          <option value="">-- Select Column --</option>
                          {availableColumns.filter(c => c.type === "date").map(c => (
                            <option key={c.id} value={c.id}>{c.title}</option>
                          ))}
                        </select>
                      </div>

                      {/* Initial Contact Date */}
                      <div className="space-y-2">
                        <label className="text-xs font-bold text-slate-400 uppercase tracking-wider">Initial Contact Date</label>
                        <select 
                          value={config.initialContactDateColumnId}
                          onChange={(e) => setConfig({...config, initialContactDateColumnId: e.target.value})}
                          className="w-full p-3 bg-slate-800 text-white border border-slate-700 rounded-xl outline-none focus:ring-2 focus:ring-blue-500 transition-all"
                        >
                          <option value="">-- Select Column --</option>
                          {availableColumns.filter(c => c.type === "date").map(c => (
                            <option key={c.id} value={c.id}>{c.title}</option>
                          ))}
                        </select>
                      </div>

                      {/* Sales Rep */}
                      <div className="space-y-2">
                        <label className="text-xs font-bold text-slate-400 uppercase tracking-wider">Sales Rep</label>
                        <select 
                          value={config.salesRepColumnId}
                          onChange={(e) => setConfig({...config, salesRepColumnId: e.target.value})}
                          className="w-full p-3 bg-slate-800 text-white border border-slate-700 rounded-xl outline-none focus:ring-2 focus:ring-blue-500 transition-all"
                        >
                          <option value="">-- Select Column --</option>
                          {availableColumns.filter(c => c.type === "multiple-person" || c.type === "people" || c.type === "text").map(c => (
                            <option key={c.id} value={c.id}>{c.title}</option>
                          ))}
                        </select>
                      </div>
                      {/* Refresh Interval */}
                      <div className="space-y-2">
                        <label className="text-xs font-bold text-slate-400 uppercase tracking-wider">Refresh Interval (Hours)</label>
                        <input 
                          type="number"
                          value={config.refreshIntervalHours ?? 24}
                          onChange={(e) => setConfig({...config, refreshIntervalHours: parseInt(e.target.value) || 1})}
                          className="w-full p-3 bg-slate-800 text-white border border-slate-700 rounded-xl outline-none focus:ring-2 focus:ring-blue-500 transition-all"
                          placeholder="e.g. 24"
                        />
                        <p className="text-[10px] text-slate-500 italic">Data will be cached for this duration to speed up loading.</p>
                      </div>

                      {/* Included Sales Reps */}
                      {availableSalesReps.length > 0 && (
                        <div className="space-y-3 mt-4 pt-4 border-t border-slate-700/50">
                          <label className="text-xs font-bold text-slate-400 uppercase tracking-wider">Included Sales Reps</label>
                          <p className="text-[10px] text-slate-500 italic mb-2">Select which salespeople to include in the dashboard calculations. If none are selected, all will be included.</p>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-48 overflow-y-auto pr-2">
                            {availableSalesReps.map(rep => {
                              const isAll = !config.includedSalesReps || config.includedSalesReps.length === 0;
                              const isChecked = isAll || (config.includedSalesReps && config.includedSalesReps.includes(rep));
                              
                              return (
                                <label key={rep} className="flex items-center gap-3 p-3 bg-slate-800/50 rounded-xl border border-slate-700/50 cursor-pointer hover:bg-slate-800 transition-colors">
                                  <input 
                                    type="checkbox"
                                    checked={isChecked}
                                    onChange={(e) => {
                                      let next: string[];
                                      if (e.target.checked) {
                                        if (isAll) {
                                          next = [];
                                        } else {
                                          next = [...(config.includedSalesReps || []), rep];
                                        }
                                      } else {
                                        if (isAll) {
                                          next = availableSalesReps.filter(r => r !== rep);
                                        } else {
                                          next = (config.includedSalesReps || []).filter(r => r !== rep);
                                        }
                                      }
                                      
                                      if (next.length === availableSalesReps.length) {
                                        next = [];
                                      }
                                      
                                      setConfig({...config, includedSalesReps: next});
                                    }}
                                    className="w-4 h-4 rounded border-slate-600 text-blue-500 focus:ring-blue-500 focus:ring-offset-slate-800 bg-slate-900"
                                  />
                                  <span className="text-sm font-medium text-slate-300 truncate">{rep}</span>
                                </label>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              <div className="mt-10 pt-8 border-t border-slate-800 flex items-center justify-end gap-4">
                <button 
                  onClick={() => setIsConfiguringBoard(false)}
                  className="px-6 py-3 text-slate-400 font-bold hover:text-white transition-colors"
                >
                  Cancel
                </button>
                <button 
                  onClick={handleSaveConfig}
                  disabled={!config.boardId || !config.salesAmountColumnId}
                  className="px-8 py-3 bg-blue-600 text-white rounded-xl font-bold hover:bg-blue-700 transition-all shadow-xl shadow-blue-600/40 disabled:opacity-50 flex items-center gap-2"
                >
                  <Save className="w-4 h-4" />
                  Save Integration
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Goal Editor (Admin Only) */}
        {isEditingGoals && userRole === "admin" && (
          <div className="fixed inset-0 z-[100] bg-slate-950/95 backdrop-blur-sm p-4 md:p-8 flex items-center justify-center">
            <div className="bg-slate-900 w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl md:rounded-3xl shadow-2xl border border-slate-800 p-6 md:p-10">
              <div className="flex items-center justify-between mb-6 md:mb-8">
                <h3 className="text-xl md:text-2xl font-bold text-white flex items-center gap-3">
                  <Target className="w-6 h-6 md:w-8 md:h-8 text-blue-500" />
                  Adjust Annual Goals (2026)
                </h3>
                <button 
                  onClick={() => setIsEditingGoals(false)}
                  className="p-2 hover:bg-slate-800 rounded-full transition-colors"
                >
                  <X className="w-6 h-6 md:w-8 md:h-8 text-slate-500" />
                </button>
              </div>
              <div className="space-y-6">
                <div>
                  <label className="block text-sm font-bold text-slate-400 mb-2 uppercase tracking-wider">Company Annual Goal ($)</label>
                  <input 
                    type="number" 
                    value={goals.companyAnnualGoal ?? 0}
                    onChange={(e) => setGoals({...goals, companyAnnualGoal: Number(e.target.value)})}
                    className="w-full p-4 bg-slate-900 border border-slate-700 rounded-2xl text-xl font-bold text-white focus:ring-2 focus:ring-blue-500 outline-none"
                  />
                </div>
                <div>
                  <label className="block text-sm font-bold text-slate-400 mb-2 uppercase tracking-wider">Individual Annual Goal ($)</label>
                  <input 
                    type="number" 
                    value={goals.individualAnnualGoal ?? 0}
                    onChange={(e) => setGoals({...goals, individualAnnualGoal: Number(e.target.value)})}
                    className="w-full p-4 bg-slate-900 border border-slate-700 rounded-2xl text-xl font-bold text-white focus:ring-2 focus:ring-blue-500 outline-none"
                  />
                </div>
                <button 
                  onClick={handleSaveGoals}
                  className="w-full py-4 bg-blue-600 text-white rounded-2xl font-bold text-lg hover:bg-blue-700 transition-all shadow-xl shadow-blue-600/20 flex items-center justify-center gap-2"
                >
                  <Save className="w-5 h-5" />
                  Save Changes
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Empty State */}
        {!config.boardId && (
          <div className="flex-1 bg-slate-900 p-12 rounded-3xl border-2 border-dashed border-slate-800 flex flex-col items-center justify-center text-center">
          <div className="w-20 h-20 bg-slate-800 rounded-full flex items-center justify-center mb-6">
            <Settings className="w-10 h-10 text-slate-600" />
          </div>
          <h2 className="text-2xl font-bold text-white mb-2">Dashboard Not Configured</h2>
          <p className="text-slate-400 max-w-md mb-8">
            {userRole === "admin" 
              ? "Please click 'Board Config' to select your Calgary sales board and map the columns."
              : "The administrator has not configured the board mapping yet. Please check back later."}
          </p>
          {userRole === "admin" && (
            <button 
              onClick={() => setIsConfiguringBoard(true)}
              className="px-8 py-4 bg-blue-600 text-white rounded-2xl font-bold hover:bg-blue-700 transition-all shadow-xl shadow-blue-600/20"
            >
              Configure Now
            </button>
          )}
        </div>
      )}

      {config.boardId && !loading && (
        <div className="flex-1 flex flex-col gap-6 min-h-0">
          
          {/* Top Section: Sales by Person (Full Width) */}
          <div className="h-[350px] md:h-[450px] lg:h-[45%] bg-slate-900 p-4 md:p-6 rounded-2xl shadow-sm border border-slate-800 flex flex-col overflow-hidden flex-shrink-0">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between mb-4 md:mb-6 gap-2">
              <h3 className="text-base md:text-lg font-bold text-white flex items-center gap-2 flex-wrap">
                <Users className="w-5 h-5 text-slate-500" />
                Sales by Person (2026)
                {processedData.individualSales.length > itemsPerPage && (
                  <span className="text-[9px] md:text-[10px] bg-blue-600/20 text-blue-400 px-2 py-0.5 rounded-full uppercase tracking-tighter animate-pulse">
                    Slide {currentSalesPage + 1} of {Math.ceil(processedData.individualSales.length / itemsPerPage)}
                  </span>
                )}
              </h3>
              <div className="text-[10px] md:text-xs text-slate-500 font-medium">
                Goal: ${Math.round(goals.individualAnnualGoal).toLocaleString()} / person
              </div>
            </div>
            <div className="flex-1 min-h-0">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={paginatedSales} margin={{ top: 30, right: 30, left: 20, bottom: 40 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#1e293b" />
                  <XAxis 
                    dataKey="name" 
                    axisLine={false} 
                    tickLine={false} 
                    interval={0}
                    tick={<CustomTick />}
                  />
                  <YAxis 
                    axisLine={false} 
                    tickLine={false} 
                    tick={{fill: '#94a3b8', fontSize: 10}} 
                    tickFormatter={(val) => `$${Math.round(val).toLocaleString()}`} 
                    width={80}
                  />
                  <Tooltip 
                    contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #1e293b', borderRadius: '12px', color: '#fff' }}
                    itemStyle={{ color: '#3b82f6' }}
                    formatter={(val: number) => [`$${Math.round(val).toLocaleString()}`, 'Sales']}
                  />
                  <Bar dataKey="sales" radius={[6, 6, 0, 0]}>
                    {paginatedSales.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                    <LabelList 
                      dataKey="sales" 
                      position="top" 
                      formatter={(val: number) => `$${Math.round(val).toLocaleString()}`}
                      fill="#fff"
                      fontSize={10}
                      offset={10}
                    />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Bottom Section: Monthly Trend (Left) and Stats (Right) */}
          <div className="flex-1 grid grid-cols-1 lg:grid-cols-3 gap-6">
            
            {/* Monthly Trend - NOW LARGER (2/3) */}
            <div className="lg:col-span-2 h-[300px] md:h-[400px] lg:h-auto bg-slate-900 p-4 md:p-6 rounded-2xl shadow-sm border border-slate-800 flex flex-col">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-base md:text-lg font-bold text-white flex items-center gap-2">
                  <BarChart3 className="w-5 h-5 text-slate-500" />
                  Monthly Sales Trend (2026)
                </h3>
              </div>
              <div className="flex-1 min-h-0">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={processedData.monthlySales} margin={{ top: 30, right: 30, left: 20, bottom: 5 }}>
                    <defs>
                      <linearGradient id="colorSalesLarge" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#10b981" stopOpacity={0.2}/>
                        <stop offset="95%" stopColor="#10b981" stopOpacity={0}/>
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#1e293b" />
                    <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{fill: '#94a3b8', fontSize: 10}} />
                    <YAxis axisLine={false} tickLine={false} tick={{fill: '#94a3b8', fontSize: 10}} tickFormatter={(val) => `$${Math.round(val).toLocaleString()}`} width={60} />
                    <Tooltip 
                      contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #1e293b', borderRadius: '12px', color: '#fff' }}
                      itemStyle={{ color: '#10b981' }}
                      formatter={(val: number) => [`$${Math.round(val).toLocaleString()}`, 'Sales']}
                    />
                    <Area type="monotone" dataKey="sales" stroke="#10b981" strokeWidth={3} fillOpacity={1} fill="url(#colorSalesLarge)">
                      <LabelList 
                        dataKey="sales" 
                        position="top" 
                        formatter={(val: number) => val > 0 ? `$${Math.round(val).toLocaleString()}` : ''}
                        fill="#10b981"
                        fontSize={9}
                        offset={10}
                      />
                    </Area>
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Stats Cards - NOW IN SIDEBAR (1/3) */}
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-2 gap-4">
              <StatCard 
                title="Total Sales" 
                value={`$${Math.round(processedData.totalSales).toLocaleString()}`}
                subValue={`Goal: $${Math.round(goals.companyAnnualGoal).toLocaleString()}`}
                icon={<DollarSign className="w-5 h-5 text-emerald-500" />}
                progress={progress}
                compact
              />
              <StatCard 
                title="Jobs Sold" 
                value={processedData.totalClosed.toString()}
                subValue="Closed deals"
                icon={<Briefcase className="w-5 h-5 text-blue-500" />}
                compact
              />
              <StatCard 
                title="Avg Sale" 
                value={`$${Math.round(processedData.averageSale).toLocaleString()}`}
                subValue="Per job"
                icon={<TrendingUp className="w-5 h-5 text-purple-500" />}
                compact
              />
              <StatCard 
                title="Close Ratio" 
                value={`${processedData.totalLeads > 0 ? Math.floor((processedData.totalClosed / processedData.totalLeads) * 1000) / 10 : 0}%`}
                subValue={`${processedData.totalLeads} Leads`}
                icon={<Target className="w-5 h-5 text-orange-500" />}
                compact
              />
            </div>
          </div>
        </div>
      )}
      </main>
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
      "bg-slate-900 rounded-2xl shadow-sm border border-slate-800 flex flex-col justify-between",
      compact ? "p-4" : "p-6"
    )}>
      <div className={cn("flex justify-between items-start", compact ? "mb-2" : "mb-4")}>
        <div className={cn("bg-slate-800 rounded-xl", compact ? "p-1.5" : "p-2")}>
          {icon}
        </div>
        {trend && !compact && (
          <div className={cn(
            "flex items-center gap-1 text-xs font-bold px-2 py-1 rounded-full",
            trend === "up" ? "bg-emerald-900/30 text-emerald-400" : "bg-rose-900/30 text-rose-400"
          )}>
            {trend === "up" ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
          </div>
        )}
      </div>
      <div>
        <p className={cn("font-medium", compact ? "text-[10px] text-slate-500 uppercase tracking-wider" : "text-sm text-slate-400 mb-1")}>{title}</p>
        <h4 className={cn("font-bold text-white", compact ? "text-lg" : "text-2xl")}>{value}</h4>
        <p className={cn("text-slate-500", compact ? "text-[9px]" : "text-xs mt-1")}>{subValue}</p>
      </div>
      {progress !== undefined && (
        <div className={cn("w-full bg-slate-800 rounded-full overflow-hidden", compact ? "h-1 mt-2" : "mt-4 h-1.5")}>
          <div 
            className="h-full bg-blue-500 rounded-full transition-all duration-1000" 
            style={{ width: `${Math.min(progress, 100)}%` }}
          />
        </div>
      )}
    </div>
  );
}
