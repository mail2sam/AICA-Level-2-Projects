import { useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Pencil, Plus, Scale, Search } from 'lucide-react'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { EmptyState, Field, PageHeader, TableSkeleton } from '@/components/common'
import { CreatableCombobox } from '@/components/combobox'
import { Loader2 } from 'lucide-react'
import { QK, useComplianceMasters } from '@/hooks/use-app-data'
import { friendlyError, supabase } from '@/lib/supabase'
import { cn } from '@/lib/utils'
import type { ComplianceMaster } from '@/types/db'

/*
  The due-date engine understands a fixed set of rule shapes. This screen
  presents them in CA language and composes the engine fields, so a date
  change (or a whole new rule) is a form, not a SQL file.
*/

type RuleKind =
  | 'monthly' // day of the following month (GSTR-3B -> 20)
  | 'quarterly_rel' // day of the month after each quarter (CMP-08 -> 18)
  | 'quarterly' // explicit date per quarter (24Q -> 31-Jul/31-Oct/31-Jan/31-May)
  | 'half' // explicit date per half (MSME-1 -> 31-Oct/30-Apr)
  | 'annual' // fixed date after the FY (ITR -> 31-Jul)
  | 'agm' // AGM + offset days (AOC-4 -> AGM+30)
  | 'event' // event-driven; never auto-generated

const KIND_LABEL: Record<RuleKind, string> = {
  monthly: 'Monthly — due on a day of the following month',
  quarterly_rel: 'Quarterly — due on a day of the month after each quarter',
  quarterly: 'Quarterly — fixed date for each quarter',
  half: 'Half-yearly — fixed date for each half',
  annual: 'Annual — fixed date after the financial year',
  agm: 'Annual — anchored to the AGM',
  event: 'Event-driven — created manually, never auto-generated',
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const LAW_PREFIX: Record<string, string> = {
  'Income Tax': 'IT',
  GST: 'GST',
  'MCA-ROC': 'MCA',
  Labour: 'LAB',
}

interface DatePart {
  day: string
  month: string // '1'..'12'
}

interface Draft {
  id?: string
  name: string
  law: string
  code: string
  kind: RuleKind
  target_level: 'Client' | 'GSTIN'
  alt_group: string
  frequency_overridable: boolean
  due_day: string
  due_month: string
  before_fy: boolean
  agm_offset: string
  schedule: DatePart[] // 4 for quarterly, 2 for half
  event_text: string
  notes: string
}

const EMPTY_PART: DatePart = { day: '', month: '' }

const EMPTY: Draft = {
  name: '',
  law: '',
  code: '',
  kind: 'monthly',
  target_level: 'Client',
  alt_group: '',
  frequency_overridable: false,
  due_day: '',
  due_month: '',
  before_fy: false,
  agm_offset: '30',
  schedule: [EMPTY_PART, EMPTY_PART, EMPTY_PART, EMPTY_PART],
  event_text: '',
  notes: '',
}

function kindOf(rule: ComplianceMaster): RuleKind {
  switch (rule.due_rule_type) {
    case 'period_relative':
      return rule.frequency === 'Quarterly' ? 'quarterly_rel' : 'monthly'
    case 'quarterly_schedule':
      return 'quarterly'
    case 'half_yearly_schedule':
      return 'half'
    case 'fixed_annual':
      return 'annual'
    case 'event_anchored':
      return rule.due_event === 'AGM' ? 'agm' : 'event'
    default:
      return 'event'
  }
}

/** "Q1=31-Jul; Q2=31-Oct" -> parts in label order. */
function parseSchedule(raw: string | null, labels: string[]): DatePart[] {
  const parts = labels.map(() => ({ ...EMPTY_PART }))
  if (!raw) return parts
  for (const piece of raw.split(';')) {
    const [label, date] = piece.split('=').map((s) => s.trim())
    const index = labels.findIndex((l) => l.toLowerCase() === (label ?? '').toLowerCase())
    if (index === -1 || !date) continue
    const [day, mon] = date.split('-')
    const monthIndex = MONTHS.findIndex((m) => m.toLowerCase() === (mon ?? '').toLowerCase())
    parts[index] = {
      day: String(parseInt(day, 10) || ''),
      month: monthIndex === -1 ? '' : String(monthIndex + 1),
    }
  }
  return parts
}

function composeSchedule(parts: DatePart[], labels: string[]): string {
  return labels
    .map((label, i) => `${label}=${parts[i].day}-${MONTHS[Number(parts[i].month) - 1]}`)
    .join('; ')
}

function suggestCode(law: string, name: string): string {
  const prefix = LAW_PREFIX[law] ?? (law.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase() || 'GEN')
  const slug = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 28)
  return `${prefix}_${slug}`
}

export default function ComplianceRulesPage() {
  const queryClient = useQueryClient()
  const rulesQuery = useComplianceMasters()

  const [search, setSearch] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [draft, setDraft] = useState<Draft>(EMPTY)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [codeTouched, setCodeTouched] = useState(false)
  const [openSections, setOpenSections] = useState<string[]>([])
  const [touchedSections, setTouchedSections] = useState(false)

  const rules = rulesQuery.data ?? []
  const laws = useMemo(() => {
    const set = new Set(Object.keys(LAW_PREFIX))
    for (const rule of rules) if (rule.law) set.add(rule.law)
    return [...set].sort((a, b) => a.localeCompare(b))
  }, [rules])

  const term = search.trim().toLowerCase()
  const grouped = useMemo(() => {
    const map = new Map<string, ComplianceMaster[]>()
    for (const rule of rules) {
      if (
        term &&
        !rule.name.toLowerCase().includes(term) &&
        !rule.code.toLowerCase().includes(term) &&
        !(rule.due_rule_text ?? '').toLowerCase().includes(term)
      ) {
        continue
      }
      const law = rule.law ?? 'Other'
      const list = map.get(law) ?? []
      list.push(rule)
      map.set(law, list)
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [rules, term])

  const defaultOpen = grouped.length ? [grouped[0][0]] : []
  const accordionValue = term
    ? grouped.map(([law]) => law)
    : touchedSections
      ? openSections
      : defaultOpen

  const save = useMutation({
    mutationFn: async (payload: Draft) => {
      const labels = payload.kind === 'half' ? ['H1', 'H2'] : ['Q1', 'Q2', 'Q3', 'Q4']

      const row: Record<string, unknown> = {
        name: payload.name.trim(),
        law: payload.law.trim(),
        code: payload.code.trim().toUpperCase(),
        target_level: payload.target_level,
        alt_group: payload.alt_group.trim() || null,
        frequency_overridable: payload.frequency_overridable,
        notes: payload.notes.trim() || null,
        // reset all rule fields, then set the ones this kind uses
        due_rule_type: null,
        due_anchor: null,
        due_day: null,
        due_month: null,
        due_event: null,
        due_offset_days: null,
        period_due_dates: null,
        is_generatable: payload.kind !== 'event',
      }

      switch (payload.kind) {
        case 'monthly':
          Object.assign(row, {
            frequency: 'Monthly',
            period_basis: 'Calendar Period',
            due_rule_type: 'period_relative',
            due_anchor: 'next_month',
            due_day: Number(payload.due_day),
            due_rule_text: `Day ${payload.due_day} of following month`,
          })
          break
        case 'quarterly_rel':
          Object.assign(row, {
            frequency: 'Quarterly',
            period_basis: 'Calendar Period',
            due_rule_type: 'period_relative',
            due_anchor: 'next_month',
            due_day: Number(payload.due_day),
            due_rule_text: `Day ${payload.due_day} of month after quarter`,
          })
          break
        case 'quarterly':
        case 'half': {
          const schedule = composeSchedule(payload.schedule.slice(0, labels.length), labels)
          Object.assign(row, {
            frequency: payload.kind === 'half' ? 'Half Yearly' : 'Quarterly',
            period_basis: 'Calendar Period',
            due_rule_type: payload.kind === 'half' ? 'half_yearly_schedule' : 'quarterly_schedule',
            period_due_dates: schedule,
            due_rule_text: schedule,
          })
          break
        }
        case 'annual':
          Object.assign(row, {
            frequency: 'Annual',
            period_basis: 'Financial Year',
            due_rule_type: 'fixed_annual',
            due_anchor: payload.before_fy ? 'before_period' : 'next_after_period',
            due_day: Number(payload.due_day),
            due_month: Number(payload.due_month),
            due_rule_text: `${payload.due_day}-${MONTHS[Number(payload.due_month) - 1]} ${
              payload.before_fy ? 'before FY' : 'after FY'
            }`,
          })
          break
        case 'agm':
          Object.assign(row, {
            frequency: 'Annual',
            period_basis: 'Financial Year',
            due_rule_type: 'event_anchored',
            due_event: 'AGM',
            due_offset_days: Number(payload.agm_offset),
            due_rule_text: `AGM + ${payload.agm_offset} days (AGM assumed 30-Sep)`,
          })
          break
        case 'event':
          Object.assign(row, {
            frequency: 'Event',
            period_basis: 'Event',
            due_rule_type: 'event',
            due_event: 'EVT',
            due_rule_text: payload.event_text.trim() || null,
          })
          break
      }

      if (payload.id) {
        const { error } = await supabase.from('compliance_master').update(row).eq('id', payload.id)
        if (error) throw error
      } else {
        const { error } = await supabase.from('compliance_master').insert(row)
        if (error) throw error
      }
    },
    onSuccess: (_d, payload) => {
      void queryClient.invalidateQueries({ queryKey: QK.compliance })
      setDialogOpen(false)
      toast.success(payload.id ? 'Rule updated — affects future generation only' : 'Rule added')
    },
    onError: (error) => toast.error(friendlyError(error)),
  })

  const toggleActive = useMutation({
    mutationFn: async (payload: { id: string; active: boolean }) => {
      const { error } = await supabase
        .from('compliance_master')
        .update({ active: payload.active })
        .eq('id', payload.id)
      if (error) throw error
    },
    onSuccess: (_d, payload) => {
      void queryClient.invalidateQueries({ queryKey: QK.compliance })
      toast.success(
        payload.active
          ? 'Rule activated'
          : 'Rule deactivated — it stops generating and disappears from client ticks',
      )
    },
    onError: (error) => toast.error(friendlyError(error)),
  })

  function openAdd() {
    setDraft(EMPTY)
    setErrors({})
    setCodeTouched(false)
    setDialogOpen(true)
  }

  function openEdit(rule: ComplianceMaster) {
    const kind = kindOf(rule)
    setDraft({
      id: rule.id,
      name: rule.name,
      law: rule.law ?? '',
      code: rule.code,
      kind,
      target_level: rule.target_level,
      alt_group: rule.alt_group ?? '',
      frequency_overridable: rule.frequency_overridable,
      due_day: rule.due_day?.toString() ?? '',
      due_month: rule.due_month?.toString() ?? '',
      before_fy: rule.due_anchor === 'before_period',
      agm_offset: rule.due_offset_days?.toString() ?? '30',
      schedule:
        kind === 'half'
          ? [...parseSchedule(rule.period_due_dates, ['H1', 'H2']), EMPTY_PART, EMPTY_PART]
          : parseSchedule(rule.period_due_dates, ['Q1', 'Q2', 'Q3', 'Q4']),
      event_text: kind === 'event' ? (rule.due_rule_text ?? '') : '',
      notes: rule.notes ?? '',
    })
    setErrors({})
    setCodeTouched(true)
    setDialogOpen(true)
  }

  function submit(event: React.FormEvent) {
    event.preventDefault()
    const next: Record<string, string> = {}
    if (!draft.name.trim()) next.name = 'Name is required.'
    if (!draft.law.trim()) next.law = 'Pick a law or type a new one.'
    if (!draft.code.trim()) next.code = 'A short unique code is required.'

    const dayOk = (value: string) => {
      const n = Number(value)
      return Number.isInteger(n) && n >= 1 && n <= 31
    }

    if (draft.kind === 'monthly' || draft.kind === 'quarterly_rel') {
      if (!dayOk(draft.due_day)) next.due_day = 'Day between 1 and 31.'
    }
    if (draft.kind === 'annual') {
      if (!dayOk(draft.due_day)) next.due_day = 'Day between 1 and 31.'
      if (!draft.due_month) next.due_month = 'Pick the month.'
    }
    if (draft.kind === 'agm') {
      if (!Number.isInteger(Number(draft.agm_offset)) || Number(draft.agm_offset) < 0) {
        next.agm_offset = 'Offset in days, 0 or more.'
      }
    }
    if (draft.kind === 'quarterly' || draft.kind === 'half') {
      const count = draft.kind === 'half' ? 2 : 4
      for (let i = 0; i < count; i += 1) {
        if (!dayOk(draft.schedule[i].day) || !draft.schedule[i].month) {
          next.schedule = 'Fill day and month for every period.'
          break
        }
      }
    }

    setErrors(next)
    if (Object.keys(next).length) return
    save.mutate(draft)
  }

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((prev) => ({ ...prev, [key]: value }))

  const scheduleLabels = draft.kind === 'half' ? ['H1', 'H2'] : ['Q1', 'Q2', 'Q3', 'Q4']

  return (
    <div className="space-y-5">
      <PageHeader
        title="Compliance Rules"
        description="The statutory rule catalogue that drives automatic generation. Date changes here affect future tasks only — already-created tasks keep their dates."
      >
        <Button onClick={openAdd}>
          <Plus className="size-4" />
          Add Rule
        </Button>
      </PageHeader>

      <div className="relative">
        <Search className="text-muted-foreground absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
        <Input
          placeholder="Search rules…"
          className="pl-8"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {rulesQuery.isLoading ? (
        <Card className="py-0">
          <CardContent className="p-0">
            <TableSkeleton cols={5} />
          </CardContent>
        </Card>
      ) : grouped.length === 0 ? (
        <EmptyState
          icon={Scale}
          title={term ? 'Nothing matches that search' : 'No compliance rules yet'}
          description={term ? 'Try a shorter term.' : 'Run 11-compliance-seed.sql, or add rules here.'}
        />
      ) : (
        <Accordion
          type="multiple"
          value={accordionValue}
          onValueChange={(next) => {
            setTouchedSections(true)
            setOpenSections(next)
          }}
          className="space-y-2"
        >
          {grouped.map(([law, items]) => (
            <AccordionItem key={law} value={law} className="bg-card rounded-lg border px-4 last:border-b">
              <AccordionTrigger className="hover:no-underline">
                <span className="flex items-center gap-2">
                  <span className="font-medium">{law}</span>
                  <Badge variant="secondary" className="tabular-nums">
                    {items.length}
                  </Badge>
                </span>
              </AccordionTrigger>
              <AccordionContent className="pb-2">
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Rule</TableHead>
                        <TableHead>Frequency</TableHead>
                        <TableHead>Due</TableHead>
                        <TableHead>Level</TableHead>
                        <TableHead className="text-center">Auto</TableHead>
                        <TableHead className="text-center">Active</TableHead>
                        <TableHead className="text-right">Edit</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {items.map((rule) => (
                        <TableRow key={rule.id} className={cn(!rule.active && 'opacity-50')}>
                          <TableCell className="font-medium">
                            {rule.name}
                            <p className="text-muted-foreground font-mono text-[10px] font-normal">
                              {rule.code}
                              {rule.alt_group ? ` · group: ${rule.alt_group}` : ''}
                            </p>
                          </TableCell>
                          <TableCell className="whitespace-nowrap">{rule.frequency}</TableCell>
                          <TableCell className="text-muted-foreground max-w-64 truncate text-sm">
                            {rule.due_rule_text ?? '—'}
                          </TableCell>
                          <TableCell>
                            {rule.target_level === 'GSTIN' ? (
                              <Badge variant="secondary" className="font-normal">
                                per GSTIN
                              </Badge>
                            ) : (
                              <span className="text-muted-foreground text-sm">Client</span>
                            )}
                          </TableCell>
                          <TableCell className="text-center">
                            {rule.is_generatable ? (
                              <Badge variant="outline" className="border-success text-success">
                                Auto
                              </Badge>
                            ) : (
                              <Badge variant="secondary">Manual</Badge>
                            )}
                          </TableCell>
                          <TableCell className="text-center">
                            <Switch
                              checked={rule.active}
                              onCheckedChange={(checked) =>
                                toggleActive.mutate({ id: rule.id, active: checked })
                              }
                              aria-label={`Toggle ${rule.name}`}
                            />
                          </TableCell>
                          <TableCell className="text-right">
                            <Button variant="ghost" size="sm" onClick={() => openEdit(rule)}>
                              <Pencil className="size-3.5" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{draft.id ? 'Edit Compliance Rule' : 'Add Compliance Rule'}</DialogTitle>
            <DialogDescription>
              Changes apply to future generation only. Tasks already created keep their dates.
            </DialogDescription>
          </DialogHeader>

          <form className="space-y-4" onSubmit={submit} noValidate>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name" htmlFor="rule-name" error={errors.name} className="sm:col-span-2" required>
                <Input
                  id="rule-name"
                  value={draft.name}
                  onChange={(e) => {
                    const name = e.target.value
                    setDraft((prev) => ({
                      ...prev,
                      name,
                      code: codeTouched ? prev.code : suggestCode(prev.law, name),
                    }))
                  }}
                  placeholder="e.g. ITR (business income, non audit)"
                />
              </Field>

              <Field label="Law" error={errors.law} required>
                <CreatableCombobox
                  options={laws}
                  value={draft.law}
                  onChange={(law) =>
                    setDraft((prev) => ({
                      ...prev,
                      law,
                      code: codeTouched ? prev.code : suggestCode(law, prev.name),
                    }))
                  }
                  createLabel="Create law"
                />
              </Field>

              <Field
                label="Code"
                htmlFor="rule-code"
                error={errors.code}
                hint="Short unique id. Auto-suggested; edit if you like."
                required
              >
                <Input
                  id="rule-code"
                  className="font-mono"
                  value={draft.code}
                  onChange={(e) => {
                    setCodeTouched(true)
                    set('code', e.target.value.toUpperCase())
                  }}
                />
              </Field>

              <Field label="Due-date pattern" className="sm:col-span-2" required>
                <Select value={draft.kind} onValueChange={(value) => set('kind', value as RuleKind)}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(KIND_LABEL) as RuleKind[]).map((kind) => (
                      <SelectItem key={kind} value={kind}>
                        {KIND_LABEL[kind]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              {draft.kind === 'monthly' || draft.kind === 'quarterly_rel' ? (
                <Field
                  label={draft.kind === 'monthly' ? 'Due day of following month' : 'Due day of month after quarter'}
                  htmlFor="rule-day"
                  error={errors.due_day}
                  required
                >
                  <Input
                    id="rule-day"
                    type="number"
                    min="1"
                    max="31"
                    value={draft.due_day}
                    onChange={(e) => set('due_day', e.target.value)}
                    placeholder="e.g. 20"
                  />
                </Field>
              ) : null}

              {draft.kind === 'annual' ? (
                <>
                  <Field label="Due day" htmlFor="rule-aday" error={errors.due_day} required>
                    <Input
                      id="rule-aday"
                      type="number"
                      min="1"
                      max="31"
                      value={draft.due_day}
                      onChange={(e) => set('due_day', e.target.value)}
                      placeholder="e.g. 31"
                    />
                  </Field>
                  <Field label="Due month" error={errors.due_month} required>
                    <Select value={draft.due_month} onValueChange={(value) => set('due_month', value)}>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Month" />
                      </SelectTrigger>
                      <SelectContent>
                        {MONTHS.map((month, i) => (
                          <SelectItem key={month} value={String(i + 1)}>
                            {month}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <label className="flex items-center gap-2 text-sm sm:col-span-2">
                    <Checkbox
                      checked={draft.before_fy}
                      onCheckedChange={(checked) => set('before_fy', Boolean(checked))}
                    />
                    Due BEFORE the financial year starts (rare — e.g. LUT filed in March for the next FY)
                  </label>
                </>
              ) : null}

              {draft.kind === 'agm' ? (
                <Field
                  label="Days after AGM"
                  htmlFor="rule-offset"
                  error={errors.agm_offset}
                  hint="AGM assumed 30-Sep; the task's due date is provisional and editable."
                  required
                >
                  <Input
                    id="rule-offset"
                    type="number"
                    min="0"
                    value={draft.agm_offset}
                    onChange={(e) => set('agm_offset', e.target.value)}
                  />
                </Field>
              ) : null}

              {draft.kind === 'quarterly' || draft.kind === 'half' ? (
                <div className="sm:col-span-2">
                  <p className="mb-1.5 text-sm font-medium">
                    Due date per {draft.kind === 'half' ? 'half (H1 = Apr–Sep)' : 'quarter (Q1 = Apr–Jun)'}
                    <span className="text-destructive ml-0.5">*</span>
                  </p>
                  <div className={cn('grid gap-2', draft.kind === 'half' ? 'sm:grid-cols-2' : 'sm:grid-cols-4')}>
                    {scheduleLabels.map((label, i) => (
                      <div key={label} className="rounded-md border p-2">
                        <p className="text-muted-foreground mb-1 text-xs font-semibold">{label}</p>
                        <div className="flex gap-1.5">
                          <Input
                            type="number"
                            min="1"
                            max="31"
                            placeholder="Day"
                            value={draft.schedule[i].day}
                            onChange={(e) => {
                              const schedule = [...draft.schedule]
                              schedule[i] = { ...schedule[i], day: e.target.value }
                              set('schedule', schedule)
                            }}
                          />
                          <Select
                            value={draft.schedule[i].month}
                            onValueChange={(value) => {
                              const schedule = [...draft.schedule]
                              schedule[i] = { ...schedule[i], month: value }
                              set('schedule', schedule)
                            }}
                          >
                            <SelectTrigger>
                              <SelectValue placeholder="Mon" />
                            </SelectTrigger>
                            <SelectContent>
                              {MONTHS.map((month, m) => (
                                <SelectItem key={month} value={String(m + 1)}>
                                  {month}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                    ))}
                  </div>
                  {errors.schedule ? (
                    <p className="text-destructive mt-1 text-xs">{errors.schedule}</p>
                  ) : null}
                </div>
              ) : null}

              {draft.kind === 'event' ? (
                <Field
                  label="Due rule (free text)"
                  htmlFor="rule-event"
                  hint="Shown for reference; these rules never auto-generate — create them from Task Master when the event happens."
                  className="sm:col-span-2"
                >
                  <Input
                    id="rule-event"
                    value={draft.event_text}
                    onChange={(e) => set('event_text', e.target.value)}
                    placeholder="e.g. 30 days from the event"
                  />
                </Field>
              ) : null}

              <Field label="Applies at" required>
                <Select
                  value={draft.target_level}
                  onValueChange={(value) => set('target_level', value as 'Client' | 'GSTIN')}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Client">Client level — one task per client</SelectItem>
                    <SelectItem value="GSTIN">GSTIN level — one task per registration</SelectItem>
                  </SelectContent>
                </Select>
              </Field>

              <Field
                label="Mutually-exclusive group"
                htmlFor="rule-alt"
                hint="Optional. Rules sharing a group are variants — e.g. all ITR rows share 'ITR'."
              >
                <Input
                  id="rule-alt"
                  value={draft.alt_group}
                  onChange={(e) => set('alt_group', e.target.value)}
                  placeholder="e.g. ITR"
                />
              </Field>

              {draft.kind === 'monthly' ? (
                <label className="flex items-center gap-2 text-sm sm:col-span-2">
                  <Checkbox
                    checked={draft.frequency_overridable}
                    onCheckedChange={(checked) => set('frequency_overridable', Boolean(checked))}
                  />
                  Clients may override to quarterly (QRMP-style) when ticking
                </label>
              ) : null}

              <Field label="Notes" htmlFor="rule-notes" className="sm:col-span-2">
                <Textarea
                  id="rule-notes"
                  rows={2}
                  value={draft.notes}
                  onChange={(e) => set('notes', e.target.value)}
                />
              </Field>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={save.isPending}>
                {save.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
                {draft.id ? 'Save changes' : 'Add Rule'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
