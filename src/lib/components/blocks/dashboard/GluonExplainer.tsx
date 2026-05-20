/**
 * @file GluonExplainer.tsx
 * @description Collapsible "How does Gluon work?" panel. Collapsed by default.
 * Uses framer-motion AnimatePresence for height animation and a rotating chevron.
 * No Lottie, no emojis, matches the design-system color palette.
 * @module frontend/components/blocks/dashboard
 */
"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";

// ─── Section data ─────────────────────────────────────────────────────────────

const SECTIONS = [
  {
    borderColor: "border-emerald-500/50",
    headingColor: "text-emerald-400",
    label: "FISSION",
    body: "Deposit ERG into the Gluon reactor and split it into two tokens: GAU (tracks gold price) and GAUC (leveraged ERG exposure). A small fee is charged and added to the reserve.",
  },
  {
    borderColor: "border-blue-500/50",
    headingColor: "text-blue-400",
    label: "FUSION",
    body: "Combine GAU and GAUC back into ERG. This is the reverse of fission. You get back ERG minus a small fee. Useful when you want to exit your position entirely.",
  },
  {
    borderColor: "border-amber-500/50",
    headingColor: "text-amber-400",
    label: "TRANSMUTATION",
    body: "Swap between GAU and GAUC directly without going through ERG. The exchange rate is determined by the oracle price and reserve ratio. Fees apply and flow back into the reserve, increasing GAUC backing over time.",
  },
  {
    borderColor: "border-gray-200 dark:border-white/20",
    headingColor: "text-gray-600 dark:text-white/60",
    label: "RESERVE RATIO",
    body: "The reserve ratio is the total ERG in the reactor divided by the ERG value of all circulating GAU. A higher ratio means Neutron is better collateralized and the protocol is healthier. The ratio drops when ERG price falls or GAU supply increases.",
  },
] as const;

// ─── Component ────────────────────────────────────────────────────────────────

export function GluonExplainer() {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="mt-6 overflow-hidden rounded-xl border border-gray-200 dark:border-white/[0.07] bg-white dark:bg-[#141414]">
      {/* Header row — always visible */}
      <button
        id="gluon-explainer-toggle"
        type="button"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((prev) => !prev)}
        className="flex w-full cursor-pointer items-center justify-between px-4 py-3"
      >
        <span className="text-sm font-semibold text-gray-900 dark:text-white">
          How does Gluon work?
        </span>
        <motion.span
          animate={{ rotate: isOpen ? 180 : 0 }}
          transition={{ duration: 0.25, ease: "easeInOut" }}
          className="text-gray-400 dark:text-white/40 text-base leading-none select-none"
          aria-hidden
        >
          &#9662;
        </motion.span>
      </button>

      {/* Expanded content */}
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div
            key="explainer-body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: "easeInOut" }}
            style={{ overflow: "hidden" }}
          >
            <div className="px-4 pb-5 pt-1">
              {SECTIONS.map((s) => (
                <div
                  key={s.label}
                  className={`mb-4 border-l-2 pl-4 ${s.borderColor}`}
                >
                  <p className={`mb-1 text-xs font-semibold ${s.headingColor}`}>
                    {s.label}
                  </p>
                  <p className="text-xs leading-relaxed text-gray-500 dark:text-white/50">
                    {s.body}
                  </p>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
