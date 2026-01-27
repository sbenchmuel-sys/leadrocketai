import { cn } from "@/lib/utils";

interface LeadAvatarProps {
  name: string;
  company: string;
  leadId: string;
  size?: "sm" | "md" | "lg";
  className?: string;
}

// Generate a consistent color based on a string hash
function hashStringToColor(str: string): string {
  const colors = [
    "bg-blue-500",
    "bg-green-500",
    "bg-purple-500",
    "bg-orange-500",
    "bg-pink-500",
    "bg-cyan-500",
    "bg-indigo-500",
    "bg-teal-500",
    "bg-amber-500",
    "bg-rose-500",
  ];
  
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  
  return colors[Math.abs(hash) % colors.length];
}

function getInitials(name: string, company: string): string {
  const nameInitial = name.trim().charAt(0).toUpperCase();
  const companyInitial = company.trim().charAt(0).toUpperCase();
  return `${nameInitial}${companyInitial}`;
}

const sizeClasses = {
  sm: "h-7 w-7 text-xs",
  md: "h-9 w-9 text-sm",
  lg: "h-11 w-11 text-base",
};

export function LeadAvatar({ name, company, leadId, size = "md", className }: LeadAvatarProps) {
  const initials = getInitials(name, company);
  const bgColor = hashStringToColor(leadId);
  
  return (
    <div
      className={cn(
        "flex items-center justify-center rounded-full text-white font-medium shrink-0",
        bgColor,
        sizeClasses[size],
        className
      )}
      title={`${name} at ${company}`}
    >
      {initials}
    </div>
  );
}
