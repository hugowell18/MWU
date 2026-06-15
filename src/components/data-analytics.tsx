import React, { useState } from 'react';
import { 
  BarChart, 
  Bar, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer, 
  Cell,
  LineChart,
  Line,
  AreaChart,
  Area
} from 'recharts';
import { 
  Upload, 
  FileUp, 
  Filter, 
  Download, 
  Table as TableIcon,
  PieChart as PieChartIcon,
  Activity,
  Trash2,
  Share2
} from 'lucide-react';

// Mock data generated from "Desktop Runner CSV"
const MOCK_SESSION_DATA = [
  { stimulus: 'APPLE', type: 'word', rt: 450, correct: true, trial: 1 },
  { stimulus: 'GRAPW', type: 'nonword', rt: 620, correct: true, trial: 2 },
  { stimulus: 'HOUSE', type: 'word', rt: 410, correct: true, trial: 3 },
  { stimulus: 'BLORT', type: 'nonword', rt: 850, correct: false, trial: 4 },
  { stimulus: 'TABLE', type: 'word', rt: 480, correct: true, trial: 5 },
  { stimulus: 'SMURP', type: 'nonword', rt: 590, correct: true, trial: 6 },
  { stimulus: 'CLOUD', type: 'word', rt: 520, correct: true, trial: 7 },
  { stimulus: 'ZINCH', type: 'nonword', rt: 680, correct: true, trial: 8 },
  { stimulus: 'BREAD', type: 'word', rt: 430, correct: true, trial: 9 },
  { stimulus: 'FLURK', type: 'nonword', rt: 710, correct: true, trial: 10 },
  { stimulus: 'CHAIR', type: 'word', rt: 440, correct: true, trial: 11 },
  { stimulus: 'SPLAT', type: 'nonword', rt: 920, correct: false, trial: 12 },
];

export function DataAnalytics() {
  const [data, setData] = useState<any[] | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [viewMode, setViewMode] = useState<'visual' | 'table'>('visual');
  const [isCleaned, setIsCleaned] = useState(true);

  const getCleanedData = (rawData: any[]) => {
    // 1. Remove incorrect trials
    let cleaned = rawData.filter(d => d.correct);
    
    // 2. Absolute cutoff: 200ms < RT < 2000ms
    cleaned = cleaned.filter(d => d.rt >= 200 && d.rt <= 2000);
    
    if (cleaned.length === 0) return [];

    // 3. Relative cutoff: mean ± 2.5 SD
    const mean = cleaned.reduce((acc, curr) => acc + curr.rt, 0) / cleaned.length;
    const squareDiffs = cleaned.map(d => Math.pow(d.rt - mean, 2));
    const avgSquareDiff = squareDiffs.reduce((acc, val) => acc + val, 0) / squareDiffs.length;
    const stdDev = Math.sqrt(avgSquareDiff);
    
    return cleaned.filter(d => {
      const zScore = Math.abs((d.rt - mean) / (stdDev || 1));
      return zScore <= 2.5;
    });
  };

  const displayData = data ? (isCleaned ? getCleanedData(data) : data) : null;

  const stats = data ? {
    avgRt: Math.round((displayData || []).reduce((acc, curr) => acc + curr.rt, 0) / ((displayData || []).length || 1)),
    accuracy: Math.round((data.filter(d => d.correct).length / data.length) * 100),
    count: data.length,
    removed: data.length - (displayData || []).length,
    wordRt: Math.round((displayData || []).filter(d => d.type === 'word').reduce((acc, curr) => acc + curr.rt, 0) / ((displayData || []).filter(d => d.type === 'word').length || 1)),
    nonwordRt: Math.round((displayData || []).filter(d => d.type === 'nonword').reduce((acc, curr) => acc + curr.rt, 0) / ((displayData || []).filter(d => d.type === 'nonword').length || 1)),
  } : null;

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    setIsUploading(true);
    // Simulate parsing
    setTimeout(() => {
      setData(MOCK_SESSION_DATA);
      setIsUploading(false);
    }, 1500);
  };

  const clearData = () => setData(null);

  return (
    <div className="py-8">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-8">
        <div>
          <h2 className="text-3xl font-extrabold text-slate-900 tracking-tight">Result Visualizer</h2>
          <p className="text-slate-500">Transform raw CSV data from the LDT runner into cohort insights.</p>
        </div>
        {data && (
          <div className="flex gap-3">
            <button className="flex items-center gap-2 px-4 py-2 bg-white border border-slate-200 rounded-lg text-sm font-semibold hover:bg-slate-50 transition-colors">
              <Share2 className="w-4 h-4 text-slate-400" />
              Share Report
            </button>
            <button 
              onClick={clearData}
              className="flex items-center gap-2 px-4 py-2 bg-red-50 border border-red-100 text-red-600 rounded-lg text-sm font-semibold hover:bg-red-100 transition-colors"
            >
              <Trash2 className="w-4 h-4" />
              Clear
            </button>
          </div>
        )}
      </div>

      {!data ? (
        <div className="max-w-2xl mx-auto">
          <label className={`
            relative flex flex-col items-center justify-center w-full h-80 border-2 border-dashed rounded-3xl cursor-pointer transition-all
            ${isUploading ? 'bg-blue-50 border-blue-200 animate-pulse' : 'bg-white border-slate-200 hover:border-blue-300 hover:bg-slate-50'}
          `}>
            <div className="flex flex-col items-center justify-center pt-5 pb-6">
              <div className="w-16 h-16 bg-blue-50 text-blue-600 rounded-2xl flex items-center justify-center mb-4">
                {isUploading ? <Activity className="w-8 h-8 animate-spin" /> : <Upload className="w-8 h-8" />}
              </div>
              <p className="mb-2 text-lg font-bold text-slate-900">
                {isUploading ? 'Processing Data...' : 'Upload LDT CSV Output'}
              </p>
              <p className="text-sm text-slate-500 text-center px-12">
                Drag and drop your export from the desktop app. <br />We'll automatically parse and visualize the distribution.
              </p>
            </div>
            <input type="file" className="hidden" onChange={handleFileUpload} accept=".csv" />
          </label>
          
          <div className="mt-8 grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="p-4 bg-slate-100/50 rounded-xl border border-slate-200/60 flex items-center gap-4">
              <FileUp className="w-5 h-5 text-slate-400" />
              <span className="text-xs text-slate-500 font-medium">Supported Format: LDT-v2.x Standard CSV</span>
            </div>
            <div className="p-4 bg-slate-100/50 rounded-xl border border-slate-200/60 flex items-center gap-4">
              <Download className="w-5 h-5 text-slate-400" />
              <button className="text-xs text-blue-600 font-bold hover:underline">Download Sample Data</button>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-8">
          {/* Summary Stats */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              { label: 'Accuracy', value: `${stats?.accuracy}%`, trend: '+2.4%', color: 'blue' },
              { label: 'Mean RT', value: `${stats?.avgRt}ms`, trend: '-12ms', color: 'green' },
              { label: 'Word RT', value: `${stats?.wordRt}ms`, trend: 'Normal', color: 'purple' },
              { label: 'Nonword RT', value: `${stats?.nonwordRt}ms`, trend: 'Expected', color: 'orange' },
            ].map((stat, i) => (
              <div key={i} className="bg-white p-6 rounded-2xl border border-slate-100 shadow-sm">
                <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-2">{stat.label}</p>
                <div className="flex items-end justify-between">
                  <p className="text-3xl font-black text-slate-900 tracking-tight">{stat.value}</p>
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded bg-${stat.color}-50 text-${stat.color}-600 border border-${stat.color}-100`}>
                    {stat.trend}
                  </span>
                </div>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-4 mb-6">
            <div className="flex items-center gap-2 p-1 bg-slate-100 w-fit rounded-lg">
              <button 
                onClick={() => setViewMode('visual')}
                className={`flex items-center gap-2 px-4 py-1.5 rounded-md text-sm font-bold transition-all ${viewMode === 'visual' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
              >
                <BarChart2Icon className="w-4 h-4" />
                Visual Analysis
              </button>
              <button 
                onClick={() => setViewMode('table')}
                className={`flex items-center gap-2 px-4 py-1.5 rounded-md text-sm font-bold transition-all ${viewMode === 'table' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
              >
                <TableIcon className="w-4 h-4" />
                Trial Data
              </button>
            </div>

            <button 
              onClick={() => setIsCleaned(!isCleaned)}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold transition-all border ${isCleaned ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-200 hover:border-blue-300'}`}
            >
              <Filter className={`w-4 h-4 ${isCleaned ? 'text-white' : 'text-blue-500'}`} />
              {isCleaned ? 'Cleaning Active (Gold Standard)' : 'Viewing Raw Data'}
            </button>
            
            {isCleaned && (
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest hidden sm:block">
                Removed: {stats?.removed} outliers / incorrects
              </span>
            )}
          </div>

          {viewMode === 'visual' ? (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
              <div className="bg-white p-8 rounded-3xl border border-slate-100 shadow-sm">
                <div className="flex items-center justify-between mb-8">
                  <h3 className="font-bold text-slate-900">RT Distribution by Trial</h3>
                  <div className="flex items-center gap-2 text-xs font-medium text-slate-400">
                    <span className="flex items-center gap-1"><div className="w-2 h-2 rounded-full bg-blue-500"></div> Word</span>
                    <span className="flex items-center gap-1"><div className="w-2 h-2 rounded-full bg-slate-300"></div> Nonword</span>
                  </div>
                </div>
                <div className="h-[300px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={displayData || []}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                      <XAxis dataKey="stimulus" axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: '#94a3b8' }} />
                      <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: '#94a3b8' }} unit="ms" />
                      <Tooltip 
                        contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)' }}
                        cursor={{ fill: '#f8fafc' }}
                      />
                      <Bar dataKey="rt" radius={[4, 4, 0, 0]}>
                        {(displayData || []).map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={entry.type === 'word' ? '#3b82f6' : '#cbd5e1'} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              <div className="bg-white p-8 rounded-3xl border border-slate-100 shadow-sm">
                <div className="flex items-center justify-between mb-8">
                  <h3 className="font-bold text-slate-900">Performance Over Time</h3>
                  <button className="p-1 hover:bg-slate-50 rounded"><Filter className="w-4 h-4 text-slate-400" /></button>
                </div>
                <div className="h-[300px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={displayData || []}>
                      <defs>
                        <linearGradient id="colorRt" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.1}/>
                          <stop offset="95%" stopColor="#3b82f6" stopOpacity={0}/>
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                      <XAxis dataKey="trial" axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: '#94a3b8' }} />
                      <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: '#94a3b8' }} hide />
                      <Tooltip 
                        contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)' }}
                      />
                      <Area type="monotone" dataKey="rt" stroke="#3b82f6" strokeWidth={3} fillOpacity={1} fill="url(#colorRt)" />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>
          ) : (
            <div className="bg-white rounded-3xl border border-slate-100 shadow-sm overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-500 uppercase text-[10px] tracking-widest border-b border-slate-100">
                  <tr>
                    <th className="px-6 py-4 text-left">Trial ID</th>
                    <th className="px-6 py-4 text-left">Stimulus</th>
                    <th className="px-6 py-4 text-left">Category</th>
                    <th className="px-6 py-4 text-right">RT (ms)</th>
                    <th className="px-6 py-4 text-right">Accuracy</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {(displayData || []).map((row, i) => (
                    <tr key={i} className="hover:bg-slate-50/50 transition-colors">
                      <td className="px-6 py-4 text-slate-400 font-mono">#{String(row.trial).padStart(3, '0')}</td>
                      <td className="px-6 py-4 font-bold text-slate-900">{row.stimulus}</td>
                      <td className="px-6 py-4">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold uppercase ${row.type === 'word' ? 'bg-blue-50 text-blue-600' : 'bg-slate-100 text-slate-600'}`}>
                          {row.type}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-right font-mono">{row.rt}</td>
                      <td className="px-6 py-4 text-right">
                        <div className={`w-2 h-2 rounded-full inline-block ${row.correct ? 'bg-green-500' : 'bg-red-500'}`}></div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const BarChart2Icon = ({ className }: { className?: string }) => (
  <svg className={className} xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" />
  </svg>
);
