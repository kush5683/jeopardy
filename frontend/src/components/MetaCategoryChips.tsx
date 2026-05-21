import {
  META_CATEGORIES,
  MetaCategory,
  useMetaCategories,
} from "../hooks/useMetaCategories";

type Props = {
  onChange?: () => void;
};

export function MetaCategoryChips({ onChange }: Props) {
  const { disabled, toggle, enableAll } = useMetaCategories();
  const lastOnCount = META_CATEGORIES.length - disabled.length;
  const allOn = disabled.length === 0;

  function handleToggle(m: MetaCategory, isLastOn: boolean) {
    if (isLastOn) return;
    toggle(m);
    onChange?.();
  }

  function handleAll() {
    if (allOn) return;
    enableAll();
    onChange?.();
  }

  return (
    <div className="flex flex-wrap gap-1.5 justify-center">
      <button
        key="__all"
        onClick={handleAll}
        disabled={allOn}
        className={`px-3 py-1.5 rounded-full border text-xs sm:text-xs transition min-h-[36px] ${
          allOn
            ? "bg-white/10 text-white/60 border-white/30 cursor-default"
            : "border-jeopardy-gold text-jeopardy-gold hover:bg-jeopardy-gold/10"
        }`}
        title={allOn ? "All categories already enabled" : "Enable all categories"}
      >
        All
      </button>
      {META_CATEGORIES.map((m) => {
        const isOn = !disabled.includes(m);
        const isLastOn = isOn && lastOnCount === 1;
        return (
          <button
            key={m}
            onClick={() => handleToggle(m, isLastOn)}
            disabled={isLastOn}
            className={`px-3 py-1.5 rounded-full border text-xs sm:text-xs transition min-h-[36px] ${
              isOn
                ? "bg-jeopardy-gold text-black border-jeopardy-gold"
                : "border-white/30 text-white/50 hover:bg-white/10"
            } ${isLastOn ? "opacity-60 cursor-not-allowed" : ""}`}
            title={
              isLastOn
                ? "At least one category must stay on"
                : isOn
                ? `${m} on — click to disable`
                : `${m} off — click to enable`
            }
          >
            {m}
          </button>
        );
      })}
    </div>
  );
}
