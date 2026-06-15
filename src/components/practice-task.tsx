import React, { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Keyboard, 
  Play, 
  RotateCcw, 
  CheckCircle2, 
  XCircle, 
  AlertCircle,
  Trophy
} from 'lucide-react';

const STIMULI = [
  { word: 'APPLE', type: 'word' },
  { word: 'GRAPW', type: 'nonword' },
  { word: 'HOUSE', type: 'word' },
  { word: 'BLORT', type: 'nonword' },
  { word: 'TABLE', type: 'word' },
  { word: 'SMURP', type: 'nonword' },
  { word: 'CLOUD', type: 'word' },
  { word: 'ZINCH', type: 'nonword' },
  { word: 'BREAD', type: 'word' },
  { word: 'FLURK', type: 'nonword' },
];

export function PracticeTask() {
  const [gameState, setGameState] = useState<'idle' | 'instructions' | 'playing' | 'results'>('idle');
  const [currentIndex, setCurrentIndex] = useState(0);
  const [results, setResults] = useState<{ word: string, type: string, correct: boolean, rt: number }[]>([]);
  const [startTime, setStartTime] = useState(0);
  const [lastFeedback, setLastFeedback] = useState<'correct' | 'incorrect' | null>(null);

  const startTask = () => {
    setGameState('playing');
    setCurrentIndex(0);
    setResults([]);
    setStartTime(Date.now());
  };

  const handleResponse = useCallback((response: 'word' | 'nonword') => {
    if (gameState !== 'playing') return;

    const endTime = Date.now();
    const rt = endTime - startTime;
    const currentStimulus = STIMULI[currentIndex];
    const isCorrect = response === currentStimulus.type;

    setLastFeedback(isCorrect ? 'correct' : 'incorrect');
    setResults(prev => [...prev, { ...currentStimulus, correct: isCorrect, rt }]);

    if (currentIndex < STIMULI.length - 1) {
      setTimeout(() => {
        setCurrentIndex(prev => prev + 1);
        setStartTime(Date.now());
        setLastFeedback(null);
      }, 300);
    } else {
      setTimeout(() => {
        setGameState('results');
        setLastFeedback(null);
      }, 300);
    }
  }, [currentIndex, gameState, startTime]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (gameState !== 'playing') return;
      
      if (e.key.toLowerCase() === 'f') {
        handleResponse('word');
      } else if (e.key.toLowerCase() === 'j') {
        handleResponse('nonword');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [gameState, handleResponse]);

  const rawAccuracy = Math.round((results.filter(r => r.correct).length / STIMULI.length) * 100) || 0;
  const rawAvgRt = Math.round(results.reduce((acc, curr) => acc + curr.rt, 0) / (results.length || 1));

  // Data Cleaning Logic
  const getCleanedData = () => {
    // 1. Remove incorrect trials
    let cleaned = results.filter(r => r.correct);
    
    // 2. Absolute cutoff: 200ms < RT < 2000ms
    cleaned = cleaned.filter(r => r.rt >= 200 && r.rt <= 2000);
    
    if (cleaned.length === 0) return { data: [], avgRt: 0, removedCount: results.length };

    // 3. Relative cutoff: mean ± 2.5 SD
    const mean = cleaned.reduce((acc, curr) => acc + curr.rt, 0) / cleaned.length;
    const squareDiffs = cleaned.map(r => Math.pow(r.rt - mean, 2));
    const avgSquareDiff = squareDiffs.reduce((acc, val) => acc + val, 0) / squareDiffs.length;
    const stdDev = Math.sqrt(avgSquareDiff);
    
    const finalCleaned = cleaned.filter(r => {
      const zScore = Math.abs((r.rt - mean) / (stdDev || 1));
      return zScore <= 2.5;
    });

    const finalAvgRt = Math.round(finalCleaned.reduce((acc, curr) => acc + curr.rt, 0) / (finalCleaned.length || 1));
    
    return {
      data: finalCleaned,
      avgRt: finalAvgRt,
      removedCount: results.length - finalCleaned.length
    };
  };

  const cleanedResults = getCleanedData();

  return (
    <div className="max-w-4xl mx-auto py-8">
      <div className="bg-white rounded-3xl shadow-xl overflow-hidden border border-slate-200">
        <div className="bg-slate-900 px-8 py-6 flex justify-between items-center text-white">
          <div>
            <h2 className="text-xl font-bold">LDT Preview Console</h2>
            <p className="text-slate-400 text-xs uppercase tracking-widest mt-1">Practice Mode • Non-Experimental</p>
          </div>
          <div className="flex items-center gap-4">
            {gameState === 'playing' && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-400 uppercase">Progress</span>
                <div className="w-32 h-2 bg-slate-800 rounded-full overflow-hidden">
                  <div 
                    className="h-full bg-blue-500 transition-all duration-300" 
                    style={{ width: `${((currentIndex + 1) / STIMULI.length) * 100}%` }}
                  ></div>
                </div>
                <span className="text-xs font-mono">{currentIndex + 1}/{STIMULI.length}</span>
              </div>
            )}
            <button 
              onClick={() => setGameState('idle')}
              className="p-2 hover:bg-slate-800 rounded-lg transition-colors"
            >
              <RotateCcw className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="min-h-[400px] flex items-center justify-center p-12 relative overflow-hidden">
          {/* Decorative Grid Background */}
          <div className="absolute inset-0 opacity-[0.03] pointer-events-none" style={{ backgroundImage: 'radial-gradient(#000 1px, transparent 1px)', backgroundSize: '24px 24px' }}></div>

          <AnimatePresence mode="wait">
            {gameState === 'idle' && (
              <motion.div 
                key="idle"
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 1.05 }}
                className="text-center"
              >
                <div className="w-20 h-20 bg-blue-50 text-blue-600 rounded-3xl flex items-center justify-center mx-auto mb-6">
                  <Play className="w-10 h-10 fill-current" />
                </div>
                <h3 className="text-3xl font-bold text-slate-900 mb-4">Ready to Begin?</h3>
                <p className="text-slate-500 max-w-md mx-auto mb-8">
                  Experience the task flow exactly as a participant would in the desktop app. 
                  Get familiar with the controls and the pace.
                </p>
                <button 
                  onClick={() => setGameState('instructions')}
                  className="bg-slate-900 text-white px-8 py-4 rounded-2xl font-bold hover:bg-slate-800 transition-all shadow-lg"
                >
                  Start Practice Session
                </button>
              </motion.div>
            )}

            {gameState === 'instructions' && (
              <motion.div 
                key="instructions"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                className="w-full max-w-2xl"
              >
                <h3 className="text-2xl font-bold text-slate-900 mb-6 text-center">Instructions</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
                  <div className="p-6 bg-slate-50 rounded-2xl border border-slate-200 text-center">
                    <div className="w-12 h-12 bg-white shadow-sm border border-slate-200 rounded-xl flex items-center justify-center text-2xl font-bold text-blue-600 mx-auto mb-4">F</div>
                    <p className="font-bold text-slate-900">Real Word</p>
                    <p className="text-sm text-slate-500 mt-1">Press if the stimulus is a valid English word.</p>
                  </div>
                  <div className="p-6 bg-slate-50 rounded-2xl border border-slate-200 text-center">
                    <div className="w-12 h-12 bg-white shadow-sm border border-slate-200 rounded-xl flex items-center justify-center text-2xl font-bold text-slate-400 mx-auto mb-4">J</div>
                    <p className="font-bold text-slate-900">Nonword</p>
                    <p className="text-sm text-slate-500 mt-1">Press if the stimulus is NOT a valid English word.</p>
                  </div>
                </div>
                <div className="bg-amber-50 border border-amber-200 p-4 rounded-xl mb-8 flex gap-3 items-start text-amber-900 text-sm">
                  <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
                  <p>Remember: React as <span className="font-bold">quickly</span> and <span className="font-bold">accurately</span> as possible. Your hands should rest on the F and J keys.</p>
                </div>
                <button 
                  onClick={startTask}
                  className="w-full bg-blue-600 text-white py-4 rounded-2xl font-bold hover:bg-blue-700 transition-all shadow-lg shadow-blue-100"
                >
                  I'm Ready
                </button>
              </motion.div>
            )}

            {gameState === 'playing' && (
              <motion.div 
                key="playing"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="text-center"
              >
                <div className="mb-12">
                  <motion.div
                    key={currentIndex}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="text-6xl md:text-8xl font-black tracking-widest text-slate-900"
                  >
                    {STIMULI[currentIndex].word}
                  </motion.div>
                </div>

                <div className="flex gap-4 justify-center">
                  <div className={`transition-all duration-200 rounded-2xl p-4 border-2 ${lastFeedback === 'correct' ? 'bg-green-50 border-green-200 scale-110' : 'bg-white border-slate-100 opacity-20'}`}>
                    <CheckCircle2 className={`w-8 h-8 ${lastFeedback === 'correct' ? 'text-green-600' : 'text-slate-300'}`} />
                  </div>
                  <div className={`transition-all duration-200 rounded-2xl p-4 border-2 ${lastFeedback === 'incorrect' ? 'bg-red-50 border-red-200 scale-110' : 'bg-white border-slate-100 opacity-20'}`}>
                    <XCircle className={`w-8 h-8 ${lastFeedback === 'incorrect' ? 'text-red-600' : 'text-slate-300'}`} />
                  </div>
                </div>
                
                <p className="mt-8 text-slate-400 text-xs uppercase tracking-widest flex items-center justify-center gap-2">
                  <Keyboard className="w-4 h-4" />
                  Press F (Word) or J (Nonword)
                </p>
              </motion.div>
            )}

            {gameState === 'results' && (
              <motion.div 
                key="results"
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                className="w-full"
              >
                <div className="text-center mb-8">
                  <div className="w-16 h-16 bg-yellow-50 text-yellow-600 rounded-full flex items-center justify-center mx-auto mb-4">
                    <Trophy className="w-8 h-8" />
                  </div>
                  <h3 className="text-2xl font-bold text-slate-900">Session Complete</h3>
                  <p className="text-slate-500">Summary of your practice trial</p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
                  <div className="bg-slate-50 p-6 rounded-2xl border border-slate-200 text-center relative overflow-hidden group">
                    <div className="absolute top-2 right-2 px-2 py-0.5 bg-blue-100 text-blue-700 text-[10px] font-bold rounded uppercase">Raw</div>
                    <p className="text-slate-500 text-sm font-medium uppercase tracking-wider mb-1">Accuracy</p>
                    <p className="text-4xl font-black text-slate-900">{rawAccuracy}%</p>
                  </div>
                  <div className="bg-slate-50 p-6 rounded-2xl border border-slate-200 text-center relative overflow-hidden group">
                    <div className="absolute top-2 right-2 px-2 py-0.5 bg-blue-100 text-blue-700 text-[10px] font-bold rounded uppercase">Raw</div>
                    <p className="text-slate-500 text-sm font-medium uppercase tracking-wider mb-1">Avg RT</p>
                    <p className="text-4xl font-black text-slate-900">{rawAvgRt}ms</p>
                  </div>
                </div>

                <div className="bg-blue-600 p-6 rounded-2xl mb-8 text-white relative overflow-hidden">
                  <div className="relative z-10 flex flex-col md:flex-row justify-between items-center gap-4">
                    <div className="text-center md:text-left">
                      <p className="text-blue-200 text-xs font-bold uppercase tracking-widest mb-1">Cleaned Experimental Mean</p>
                      <p className="text-5xl font-black">{cleanedResults.avgRt}ms</p>
                    </div>
                    <div className="flex flex-col gap-1 items-center md:items-end">
                      <div className="flex items-center gap-2 text-xs font-bold bg-blue-700 px-3 py-1 rounded-full border border-blue-500/50">
                        <CheckCircle2 className="w-3 h-3" />
                        Outliers Removed: {cleanedResults.removedCount}
                      </div>
                      <p className="text-[10px] text-blue-200 uppercase tracking-tighter mt-1">Applied: Error-removal • 200-2000ms Cutoff • 2.5 SD Filter</p>
                    </div>
                  </div>
                  {/* Decorative background circle */}
                  <div className="absolute -right-8 -bottom-8 w-32 h-32 bg-white/10 rounded-full blur-2xl"></div>
                </div>

                <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden mb-8">
                  <div className="max-h-48 overflow-y-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-slate-50 text-slate-500 uppercase text-[10px] tracking-widest sticky top-0">
                        <tr>
                          <th className="px-6 py-3 text-left">Stimulus</th>
                          <th className="px-6 py-3 text-left">Type</th>
                          <th className="px-6 py-3 text-right">Result</th>
                          <th className="px-6 py-3 text-right">RT</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {results.map((r, i) => (
                          <tr key={i} className="hover:bg-slate-50 transition-colors">
                            <td className="px-6 py-3 font-mono font-bold">{r.word}</td>
                            <td className="px-6 py-3 text-slate-500 capitalize">{r.type}</td>
                            <td className="px-6 py-3 text-right">
                              <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold uppercase ${r.correct ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                                {r.correct ? 'Correct' : 'Incorrect'}
                              </span>
                            </td>
                            <td className="px-6 py-3 text-right text-slate-500">{r.rt}ms</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="flex flex-col sm:flex-row gap-4">
                  <button 
                    onClick={startTask}
                    className="flex-1 bg-slate-900 text-white py-4 rounded-2xl font-bold hover:bg-slate-800 transition-all flex items-center justify-center gap-2"
                  >
                    <RotateCcw className="w-5 h-5" />
                    Try Again
                  </button>
                  <button 
                    onClick={() => setGameState('idle')}
                    className="flex-1 bg-slate-50 text-slate-600 py-4 rounded-2xl font-bold hover:bg-slate-100 border border-slate-200 transition-all"
                  >
                    Return to Start
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <div className="bg-slate-50 px-8 py-4 border-t border-slate-200 flex items-center justify-center gap-6">
          <div className="flex items-center gap-2 text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em]">
            <div className="w-1.5 h-1.5 rounded-full bg-blue-500"></div>
            Internal Stimuli Set 1A
          </div>
          <div className="flex items-center gap-2 text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em]">
            <div className="w-1.5 h-1.5 rounded-full bg-slate-300"></div>
            Latency Correction: Disabled
          </div>
        </div>
      </div>
    </div>
  );
}
