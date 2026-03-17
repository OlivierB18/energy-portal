interface StatCardProps {
  title: string;
  value: string;
  unit: string;
  description?: string;
  color: "green" | "yellow" | "blue" | "purple";
  icon: React.ReactNode;
}

const colorMap = {
  green: {
    bg: "bg-green-50",
    border: "border-green-200",
    icon: "bg-green-100 text-green-700",
    value: "text-green-700",
  },
  yellow: {
    bg: "bg-yellow-50",
    border: "border-yellow-200",
    icon: "bg-yellow-100 text-yellow-700",
    value: "text-yellow-700",
  },
  blue: {
    bg: "bg-blue-50",
    border: "border-blue-200",
    icon: "bg-blue-100 text-blue-700",
    value: "text-blue-700",
  },
  purple: {
    bg: "bg-purple-50",
    border: "border-purple-200",
    icon: "bg-purple-100 text-purple-700",
    value: "text-purple-700",
  },
};

export function StatCard({
  title,
  value,
  unit,
  description,
  color,
  icon,
}: StatCardProps) {
  const c = colorMap[color];
  return (
    <div className={`rounded-xl border ${c.bg} ${c.border} p-5`}>
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm text-gray-600 font-medium">{title}</p>
          <p className={`text-3xl font-bold mt-1 ${c.value}`}>
            {value}
            <span className="text-base font-normal ml-1">{unit}</span>
          </p>
          {description && (
            <p className="text-xs text-gray-500 mt-1">{description}</p>
          )}
        </div>
        <div className={`w-10 h-10 rounded-lg ${c.icon} flex items-center justify-center`}>
          {icon}
        </div>
      </div>
    </div>
  );
}
