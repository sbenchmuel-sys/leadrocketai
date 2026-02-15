

## Cap Action Required entries to 5

When the "Action Required" filter is active, the PriorityActions component currently shows ALL matching leads with no limit. This needs to be capped at 5.

### Change

**File: `src/components/dashboard/PriorityActions.tsx`**

In the `actionLeads` memo, change the `action_required` branch from returning all leads to returning only the top 5 most urgent:

```
// Before (line ~56)
return sortByUrgency(leads.filter((l) => l.needs_action));

// After
return sortByUrgency(leads.filter((l) => l.needs_action)).slice(0, 5);
```

Revenue Signal and Leads Table remain unchanged -- they continue to receive the full `filteredLeads` set as before.

