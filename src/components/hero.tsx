import React from 'react';
import { motion } from 'motion/react';
import { ChevronRight, Download, PlayCircle, ShieldAlert, BarChart2 } from 'lucide-react';
import { ImageWithFallback } from './figma/ImageWithFallback';

export function Hero({ onGetStarted, onDownload }: { onGetStarted: () => void, onDownload: () => void }) {
  return (
    <div className="py-12 md:py-20">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">
        <div>
          <motion.div
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.5 }}
          >
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-50 text-blue-700 text-xs font-bold mb-6 border border-blue-100 uppercase tracking-wider">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-600"></span>
              </span>
              LDT Portal v2.4.1 Ready
            </div>
            
            <h1 className="text-5xl md:text-6xl font-extrabold text-slate-900 leading-[1.1] mb-6 tracking-tight">
              Precision Lexical <br /> 
              <span className="text-blue-600 underline decoration-blue-200 decoration-8 underline-offset-4">Decision Tasking</span>
            </h1>
            
            <p className="text-lg text-slate-600 mb-8 leading-relaxed max-w-xl">
              An intentionally scoped web portal for LDT distribution, participant training, and result visualization. 
              Designed to preserve experimental validity by centralizing RT-critical data collection in our local runner.
            </p>

            <div className="flex flex-col sm:flex-row gap-4 mb-10">
              <button 
                onClick={onDownload}
                className="bg-blue-600 text-white px-8 py-4 rounded-xl font-bold shadow-lg shadow-blue-200 hover:bg-blue-700 hover:scale-[1.02] active:scale-[0.98] transition-all flex items-center justify-center gap-2"
              >
                <Download className="w-5 h-5" />
                Download Runner
              </button>
              <button 
                onClick={onGetStarted}
                className="bg-white text-slate-700 border-2 border-slate-200 px-8 py-4 rounded-xl font-bold hover:border-slate-300 hover:bg-slate-50 hover:scale-[1.02] active:scale-[0.98] transition-all flex items-center justify-center gap-2"
              >
                <PlayCircle className="w-5 h-5 text-blue-600" />
                Try Web Preview
              </button>
            </div>

            <div className="flex items-center gap-6 p-4 bg-amber-50 rounded-xl border border-amber-100 max-w-xl">
              <div className="flex-shrink-0">
                <ShieldAlert className="w-8 h-8 text-amber-600" />
              </div>
              <div className="text-sm text-amber-900 leading-snug">
                <span className="font-bold">Important:</span> This web version is <span className="underline decoration-amber-300">not</span> for formal data collection. Reaction time data collected here is for training purposes only and does not meet experimental standards.
              </div>
            </div>
          </motion.div>
        </div>

        <motion.div 
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.7, delay: 0.2 }}
          className="relative"
        >
          <div className="relative z-10 rounded-2xl overflow-hidden shadow-2xl border-4 border-white aspect-video bg-slate-200">
            <ImageWithFallback 
              src="https://images.unsplash.com/photo-1763833294587-9eddf0fc27fa?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w3Nzg4Nzd8MHwxfHNlYXJjaHwxfHxjb2duaXRpdmUlMjBzY2llbmNlJTIwbGFib3JhdG9yeSUyMHJlc2VhcmNofGVufDF8fHx8MTc2OTg1ODY2N3ww&ixlib=rb-4.1.0&q=80&w=1080"
              alt="Lab Visualization"
              className="w-full h-full object-cover"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-slate-900/60 via-transparent to-transparent pointer-events-none"></div>
            <div className="absolute bottom-6 left-6 right-6">
              <div className="flex items-center justify-between">
                <div className="text-white">
                  <p className="text-xs font-medium uppercase tracking-widest opacity-80 mb-1">Preview Interface</p>
                  <p className="text-lg font-bold">Session Runner v2.4</p>
                </div>
                <div className="flex gap-1">
                  {[1,2,3].map(i => <div key={i} className="w-2 h-2 rounded-full bg-white/40"></div>)}
                </div>
              </div>
            </div>
          </div>
          
          {/* Decorative elements */}
          <div className="absolute -top-6 -right-6 w-32 h-32 bg-blue-100 rounded-full blur-3xl opacity-60 -z-10"></div>
          <div className="absolute -bottom-10 -left-10 w-48 h-48 bg-slate-200 rounded-full blur-3xl opacity-40 -z-10"></div>
          
          {/* Quick Metrics Floating Card */}
          <motion.div 
            initial={{ y: 20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ delay: 1, duration: 0.5 }}
            className="absolute -bottom-8 -right-8 bg-white p-6 rounded-2xl shadow-xl border border-slate-100 hidden md:block"
          >
            <div className="flex items-center gap-4 mb-3">
              <div className="p-2 bg-green-50 rounded-lg">
                <PlayCircle className="w-6 h-6 text-green-600" />
              </div>
              <div>
                <p className="text-xs font-medium text-slate-500">Live Practice Sessions</p>
                <p className="text-xl font-bold text-slate-900">1,284</p>
              </div>
            </div>
            <div className="h-2 w-32 bg-slate-100 rounded-full overflow-hidden">
              <div className="h-full bg-green-500 w-[65%]"></div>
            </div>
          </motion.div>
        </motion.div>
      </div>

      <div className="mt-24 grid grid-cols-1 md:grid-cols-3 gap-8">
        {[
          {
            title: "Access Portal",
            desc: "Download verified executables for all major desktop platforms with built-in version control.",
            icon: Download,
            color: "blue"
          },
          {
            title: "Training Interface",
            desc: "Onboard participants with interactive practice sessions. Includes instructional flow demonstrations.",
            icon: PlayCircle,
            color: "green"
          },
          {
            title: "Result Visualizer",
            desc: "Securely upload local CSV outputs for instant cohort visualization and distribution analysis.",
            icon: BarChart2,
            color: "purple"
          }
        ].map((feature, idx) => (
          <div key={idx} className="bg-white p-8 rounded-2xl border border-slate-100 hover:border-blue-200 transition-all hover:shadow-md group">
            <div className={`w-12 h-12 rounded-xl flex items-center justify-center mb-6 bg-${feature.color}-50 text-${feature.color}-600 group-hover:scale-110 transition-transform`}>
              <feature.icon className="w-6 h-6" />
            </div>
            <h3 className="text-xl font-bold text-slate-900 mb-3">{feature.title}</h3>
            <p className="text-slate-500 text-sm leading-relaxed">{feature.desc}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
