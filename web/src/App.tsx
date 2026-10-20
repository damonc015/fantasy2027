import type { Session } from '@supabase/supabase-js'
import { type FormEvent, memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type Bid, type BidResult, type Budget, type CurrentBid, type MaxBid, type Player, type ScoringRule, supabase } from './supabase'

const TABS = ['draft', 'log', 'standings'] as const
const TAB_LABELS = { draft: 'Draft', log: 'Transaction Log', standings: 'Current Standings' }
type Tab = (typeof TABS)[number]
const STATS = ['PTS', 'REB', 'AST', 'STL', 'BLK']
const POSITIONS = ['PG', 'SG', 'SF', 'PF', 'C']
const FPTS = 'Proj FPTS/G'
const TOTAL = 'Proj total'
const BID = 'High bid'
const SORTS = [TOTAL, FPTS, ...STATS, BID]
// Supabase Auth needs an email, so usernames map to an address nobody sees.
// Must match LOGIN_DOMAIN in scripts/add_manager.py.
const LOGIN_DOMAIN = 'fantasy2027.local'
// Team codes where ESPN's logo file name differs from the code in player data.
const LOGO_CODES: Record<string, string> = { NOP: 'no', PHL: 'phi', UTA: 'utah' }

const control = 'rounded-md border border-line bg-card px-2.5 py-1.5 text-sm shadow-sm focus:outline-2 focus:outline-accent'
const button = 'rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:brightness-110 disabled:opacity-50'
const pill = 'rounded-full border border-line bg-card px-3 py-1 text-sm tabular-nums'
const tableWrap = 'mt-3 max-h-[calc(100vh-13rem)] overflow-auto rounded-lg border border-line bg-card shadow-sm'
const table = 'w-full text-left text-sm [&_td]:px-3 [&_td]:py-1.5 [&_th]:px-3 [&_th]:py-2'
const tableHead = 'sticky top-0 z-10 bg-card text-xs uppercase tracking-wide whitespace-nowrap text-muted shadow-[0_1px_0_var(--line)]'
const stripedRow = 'even:bg-stripe hover:bg-accent/10'
const numeric = 'text-right tabular-nums'

const money = (amount: number) => `$${amount.toLocaleString()}`

type Message = { text: string; tone: 'ok' | 'warn' | 'error' }
type PendingBid = { playerId: number; amount: number }

const tabFromHash = (): Tab => TABS.find((tab) => `#${tab}` === location.hash) ?? 'draft'

const TITLE = 'Fantasy 2027 Auction'
const SEEN_KEY = 'outbid-seen'
// Losses before `since` are ignored; `keys` are losses already shown as a toast or acknowledged in the banner.
type Seen = { since: number; keys: string[] }
const lossKey = (bid: CurrentBid) => `${bid.player_id}:${bid.created_at}`

function readSeen(): Seen {
  try {
    const saved = JSON.parse(localStorage.getItem(SEEN_KEY) ?? 'null')
    if (saved?.since) return saved
  } catch {}
  return { since: Date.now(), keys: [] }
}

function writeSeen(seen: Seen) {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen))
  } catch {}
}

// Dev-only preview of outbid notices: open the app with ?demo-outbid
const DEMO = import.meta.env.DEV && new URLSearchParams(location.search).has('demo-outbid')
const DEMO_START = Date.now()

function demoLosses(players: Player[], managerId: string | undefined, elapsedSeconds: number): CurrentBid[] {
  if (!managerId) return []
  return players
    .slice(0, 7)
    .map((player, index) => ({
      player_id: player.id,
      manager_id: managerId,
      amount: 51 + 10 * index,
      // the first four count as lost while away (banner), the rest arrive live 3 seconds apart (toast)
      created_at: new Date(DEMO_START + (index < 4 ? -60_000 : 3_000 * (index - 3))).toISOString(),
    }))
    .filter((bid) => Date.parse(bid.created_at) <= DEMO_START + elapsedSeconds * 1000)
}

function showRow(playerId: number) {
  const row = document.getElementById(`player-${playerId}`)
  row?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  row?.animate([{ backgroundColor: 'rgb(245 158 11 / 0.5)' }, {}], 2000)
}

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data } = supabase.auth.onAuthStateChange((_event, next) => setSession(next))
    return () => data.subscription.unsubscribe()
  }, [])

  if (session === undefined) return null
  return session ? <Draft userId={session.user.id} /> : <Login />
}

function Login() {
  const [error, setError] = useState('')

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const { error } = await supabase.auth.signInWithPassword({
      email: `${String(form.get('username')).trim().toLowerCase()}@${LOGIN_DOMAIN}`,
      password: String(form.get('password')),
    })
    setError(error?.message ?? '')
  }

  return (
    <form
      onSubmit={signIn}
      className="mx-auto mt-24 flex max-w-xs flex-col gap-4 rounded-xl border border-line bg-card p-6 shadow-sm"
    >
      <h1 className="text-xl font-bold">Fantasy 2027 Auction</h1>
      <label className="flex flex-col gap-1 text-sm font-medium">
        Username
        <input name="username" required autoComplete="username" autoCapitalize="none" className={control} />
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium">
        Password
        <input name="password" type="password" required autoComplete="current-password" className={control} />
      </label>
      <button className={button}>Sign in</button>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    </form>
  )
}

function Draft({ userId }: { userId: string }) {
  const [tab, setTab] = useState<Tab>(tabFromHash)
  const [players, setPlayers] = useState<Player[]>([])
  const [leaders, setLeaders] = useState<CurrentBid[]>([])
  const [bids, setBids] = useState<Bid[]>([])
  const [myMaxes, setMyMaxes] = useState<MaxBid[]>([])
  const [budgets, setBudgets] = useState<Budget[]>([])
  const [closesAt, setClosesAt] = useState<string | null>(null)
  const [blindClosesAt, setBlindClosesAt] = useState<string | null>(null)
  const [myBlindBids, setMyBlindBids] = useState<MaxBid[]>([])
  const [now, setNow] = useState(Date.now)
  const [rosterSize, setRosterSize] = useState<number | null>(null)
  const [scoring, setScoring] = useState<ScoringRule[]>([])
  const [message, setMessage] = useState<Message | null>(null)
  const [pending, setPending] = useState<PendingBid | null>(null)
  const [seen, setSeen] = useState(() => {
    const initial = readSeen()
    writeSeen(initial)
    return initial
  })
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible')
  // Losses from before this moment (page load or tab coming back into view) go to the banner, later ones to a toast.
  const [returnedAt, setReturnedAt] = useState(Date.now)
  const [demoTick, setDemoTick] = useState(0)

  const load = useCallback(async () => {
    const [leadersResult, bidsResult, budgetsResult, auctionResult, maxesResult, blindResult] = await Promise.all([
      supabase.from('current_bids').select('player_id, manager_id, amount, created_at'),
      supabase.from('bids').select('*').order('id', { ascending: false }).limit(200),
      supabase.from('manager_budgets').select('*').order('name'),
      supabase.from('auction').select('closes_at, blind_closes_at, roster_size, scoring').maybeSingle(),
      // RLS returns only this manager's own maxes and sealed bids
      supabase.from('max_bids').select('player_id, amount'),
      supabase.from('blind_bids').select('player_id, amount'),
    ])
    const failure =
      leadersResult.error ?? bidsResult.error ?? budgetsResult.error ?? auctionResult.error ?? maxesResult.error ?? blindResult.error
    if (failure) return setMessage({ text: failure.message, tone: 'error' })
    setLeaders(leadersResult.data ?? [])
    setBids(bidsResult.data ?? [])
    setMyMaxes(maxesResult.data ?? [])
    setMyBlindBids(blindResult.data ?? [])
    setBudgets(budgetsResult.data ?? [])
    setClosesAt(auctionResult.data?.closes_at ?? null)
    setBlindClosesAt(auctionResult.data?.blind_closes_at ?? null)
    setNow(Date.now())
    setRosterSize(auctionResult.data?.roster_size ?? null)
    setScoring(auctionResult.data?.scoring ?? [])
  }, [])

  // Re-render right when the next deadline passes, so the page switches rounds on time.
  useEffect(() => {
    const next = [closesAt, blindClosesAt].map((date) => (date ? Date.parse(date) : NaN)).find((time) => time > now)
    if (next === undefined) return
    const timer = setTimeout(() => setNow(Date.now()), Math.min(next - now + 100, 2 ** 31 - 1))
    return () => clearTimeout(timer)
  }, [closesAt, blindClosesAt, now])

  useEffect(() => {
    if (!DEMO) return
    const timer = setInterval(() => setDemoTick((tick) => tick + 1), 1000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    const onVisibility = () => {
      const now = document.visibilityState === 'visible'
      if (now) setReturnedAt(Date.now())
      setVisible(now)
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  useEffect(() => {
    supabase.from('players').select('*').then(({ data, error }) => {
      if (error) setMessage({ text: error.message, tone: 'error' })
      else setPlayers(data ?? [])
    })
    // Reload on every (re)subscribe and on focus, a sleeping phone misses events.
    const channel = supabase
      .channel('bids')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'bids' }, load)
      .subscribe((status) => status === 'SUBSCRIBED' && load())
    const onHash = () => setTab(tabFromHash())
    window.addEventListener('focus', load)
    window.addEventListener('hashchange', onHash)
    return () => {
      supabase.removeChannel(channel)
      window.removeEventListener('focus', load)
      window.removeEventListener('hashchange', onHash)
    }
  }, [load])

  const playerName = useMemo(() => new Map(players.map((player) => [player.id, player.name])), [players])
  const managerName = useMemo(() => new Map(budgets.map((row) => [row.manager_id, row.name])), [budgets])
  const leaderOf = useMemo(() => new Map(leaders.map((bid) => [bid.player_id, bid])), [leaders])
  const me = budgets.find((row) => row.manager_id === userId)
  const maxOf = useMemo(() => new Map(myMaxes.map((max) => [max.player_id, max.amount])), [myMaxes])
  const blindBidOf = useMemo(() => new Map(myBlindBids.map((bid) => [bid.player_id, bid.amount])), [myBlindBids])
  const mainOpen = closesAt != null && now < Date.parse(closesAt)
  const blind = !mainOpen && blindClosesAt != null && now < Date.parse(blindClosesAt)
  // Standings show visible prices, but while the main round is open your full max on each player you lead is locked.
  const lockedAbovePrice = !mainOpen ? 0 : leaders
    .filter((bid) => bid.manager_id === userId)
    .reduce((sum, bid) => sum + (maxOf.get(bid.player_id) ?? bid.amount) - bid.amount, 0)
  const unseen = useMemo(() => {
    const keys = new Set(seen.keys)
    if (DEMO) {
      const rival = budgets.find((row) => row.manager_id !== userId)?.manager_id
      return demoLosses(players, rival, demoTick).filter((bid) => !keys.has(lossKey(bid)))
    }
    return leaders.filter(
      (bid) =>
        bid.manager_id !== userId &&
        maxOf.has(bid.player_id) &&
        Date.parse(bid.created_at) > seen.since &&
        !keys.has(lossKey(bid)),
    )
  }, [leaders, maxOf, userId, seen, players, budgets, demoTick])
  const markSeen = useCallback((keys: string[]) => {
    setSeen((prev) => {
      const next = { since: prev.since, keys: [...prev.keys, ...keys] }
      writeSeen(next)
      return next
    })
  }, [])

  // ponytail: compares server bid times to the browser clock, a few seconds of skew can put a loss in the wrong bucket
  const banner = unseen.filter((bid) => Date.parse(bid.created_at) <= returnedAt)
  const toasts = unseen.filter((bid) => Date.parse(bid.created_at) > returnedAt)
  const toastKeys = toasts.map(lossKey).join(' ')

  useEffect(() => {
    document.title = !visible && unseen.length > 0 ? `(${unseen.length}) ${TITLE}` : TITLE
  }, [visible, unseen.length])

  useEffect(() => {
    if (!visible || !toastKeys) return
    const timer = setTimeout(() => markSeen(toastKeys.split(' ')), 6000)
    return () => clearTimeout(timer)
  }, [visible, toastKeys, markSeen])

  const positionsOf = useMemo(() => new Map(players.map((player) => [player.id, player.positions])), [players])
  // A player eligible at two positions counts toward both.
  const myPositions = POSITIONS.map((position) => ({
    position,
    count: leaders.filter((bid) => bid.manager_id === userId && positionsOf.get(bid.player_id)?.includes(position)).length,
  }))

  async function placeBlindBid({ playerId, amount }: PendingBid) {
    const { error } = await supabase.rpc('place_blind_bid', { p_player_id: playerId, p_amount: amount })
    setPending(null)
    setMessage(
      error
        ? { text: error.message, tone: 'error' }
        : { text: `Sealed bid of ${money(amount)} on ${playerName.get(playerId)} saved.`, tone: 'ok' },
    )
    load()
  }
  const cancelBlindBid = useCallback(
    async (playerId: number) => {
      const { error } = await supabase.rpc('cancel_blind_bid', { p_player_id: playerId })
      setMessage(error ? { text: error.message, tone: 'error' } : { text: 'Sealed bid withdrawn.', tone: 'ok' })
      load()
    },
    [load],
  )

  async function placeBid({ playerId, amount }: PendingBid) {
    const { data, error } = await supabase.rpc('place_bid', { p_player_id: playerId, p_amount: amount })
    const result = data as BidResult | null
    const name = playerName.get(playerId)
    if (result && !result.leading) {
      // You never led, so this is not a loss to notify about; the message below already says it.
      const { data: leader } = await supabase
        .from('current_bids')
        .select('player_id, manager_id, amount, created_at')
        .eq('player_id', playerId)
        .single()
      if (leader) markSeen([lossKey(leader)])
    }
    setPending(null)
    setMessage(
      error || !result
        ? { text: error?.message ?? 'Bid failed', tone: 'error' }
        : result.leading
          ? { text: `You lead ${name} at ${money(result.price)}. Your max: ${money(result.max)}.`, tone: 'ok' }
          : {
              text: `Outbid right away on ${name}. Another manager set a higher max earlier. Price is now ${money(result.price)}.`,
              tone: 'warn',
            },
    )
    load()
  }
  const queueBid = useCallback((playerId: number, amount: number) => setPending({ playerId, amount }), [])

  return (
    <div className="mx-auto max-w-7xl p-4">
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-bold">Fantasy 2027 Auction</h1>
        <Rules closesAt={closesAt} blindClosesAt={blindClosesAt} rosterSize={rosterSize} budget={me?.budget} scoring={scoring} />
        <Countdown closesAt={blind ? blindClosesAt : closesAt} label={blind ? 'Blind round closes in' : 'Closes in'} />
        {me && (
          <>
            <span className={pill} title="Budget minus the max you set on each player you lead"><b>{money(me.remaining - lockedAbovePrice)}</b> left</span>
            <span className={pill} title="Players you currently lead">Players <b>{me.players_led}{rosterSize && `/${rosterSize}`}</b></span>
            <span className={`${pill} flex gap-2.5`} title="Players you lead at each position. Dual-position players count for both.">
              {myPositions.map(({ position, count }) => (
                <span key={position} className={count === 0 ? 'text-red-600' : ''}>
                  {position} <b>{count}</b>
                </span>
              ))}
            </span>
            <span className="ml-auto text-sm text-muted">{me.name}</span>
          </>
        )}
        <button onClick={() => supabase.auth.signOut()} className={`${control} ${me ? '' : 'ml-auto'}`}>Sign out</button>
      </header>
      <nav className="mt-4 flex gap-1">
        {TABS.map((name) => (
          <a
            key={name}
            href={`#${name}`}
            aria-current={tab === name ? 'page' : undefined}
            className={`rounded-md px-3 py-1.5 text-sm font-medium capitalize ${
              tab === name ? 'bg-accent text-white' : 'text-muted hover:bg-card'
            }`}
          >
            {TAB_LABELS[name]}
          </a>
        ))}
      </nav>
      {tab === 'draft' && message && (
        <p
          role="status"
          className={`mt-3 rounded-md border px-3 py-2 text-sm ${
            {
              ok: 'border-emerald-500/40 bg-emerald-500/10',
              warn: 'border-amber-500/40 bg-amber-500/15',
              error: 'border-red-500/40 bg-red-500/10',
            }[message.tone]
          }`}
        >
          {message.text}
        </p>
      )}

      {tab === 'draft' && visible && toasts.length > 0 && (
        <p role="status" className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/15 px-3 py-2 text-sm">
          Outbid on{' '}
          {toasts
            .map((bid) => `${playerName.get(bid.player_id)} (${managerName.get(bid.manager_id)} leads at ${money(bid.amount)})`)
            .join(', ')}
          .
        </p>
      )}

      {tab === 'draft' && banner.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-amber-500/40 bg-amber-500/15 px-3 py-2 text-sm">
          <b>While you were away you lost:</b>
          {banner.map((bid) => (
            <button key={lossKey(bid)} type="button" onClick={() => showRow(bid.player_id)} className="underline hover:text-accent">
              {playerName.get(bid.player_id)} (now {money(bid.amount)}, {managerName.get(bid.manager_id)})
            </button>
          ))}
          <button
            type="button"
            onClick={() => markSeen(banner.map(lossKey))}
            className={`${control} ml-auto`}
          >
            Got it
          </button>
        </div>
      )}

      {tab === 'draft' && (
        <PlayerPool
          players={players}
          leaderOf={leaderOf}
          maxOf={maxOf}
          blind={blind}
          blindBidOf={blindBidOf}
          managerName={managerName}
          userId={userId}
          onBid={queueBid}
          onCancelBlind={cancelBlindBid}
        />
      )}

      <ConfirmBid
        pending={pending}
        playerName={pending ? playerName.get(pending.playerId) : undefined}
        blind={blind}
        onCancel={() => setPending(null)}
        onConfirm={blind ? placeBlindBid : placeBid}
      />

      {tab === 'log' && (
        <Table head={['Time', 'Manager', 'Player', 'Bid']}>
          {bids.map((bid) => (
            <tr key={bid.id} className={stripedRow}>
              <td className="text-muted">{new Date(bid.created_at).toLocaleString()}</td>
              <td>{managerName.get(bid.manager_id)}</td>
              <td>{playerName.get(bid.player_id)}</td>
              <td className="font-semibold tabular-nums">
                {money(bid.amount)}
                {bid.auto && <span className="ml-1.5 text-xs font-normal text-muted" title="Placed by this manager's max bid">(auto)</span>}
                {bid.blind && <span className="ml-1.5 text-xs font-normal text-muted" title="Won in the blind round">(blind)</span>}
              </td>
            </tr>
          ))}
        </Table>
      )}

      {tab === 'standings' &&
        budgets.map((row) => {
          const roster = leaders.filter((bid) => bid.manager_id === row.manager_id).sort((a, b) => b.amount - a.amount)
          return (
            <section
              key={row.manager_id}
              className={`mt-3 rounded-lg border bg-card p-3 shadow-sm ${
                row.manager_id === userId ? 'border-emerald-500 shadow-[inset_3px_0_0_#10b981]' : 'border-line'
              }`}
            >
              <h2 className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm text-muted">
                <span className="text-base font-semibold text-ink">{row.name}</span>
                <span>Players <b className="text-ink tabular-nums">{row.players_led}{rosterSize && `/${rosterSize}`}</b></span>
                <span>Remaining <b className="text-ink tabular-nums">{money(row.remaining)}</b></span>
                <span>Committed <b className="text-ink tabular-nums">{money(row.committed)}</b></span>
                <span>Budget <b className="text-ink tabular-nums">{money(row.budget)}</b></span>
              </h2>
              {roster.length === 0 ? (
                <p className="mt-2 text-sm text-muted">Not leading any player yet.</p>
              ) : (
                <ul className="mt-2 flex flex-wrap gap-2">
                  {roster.map((bid) => (
                    <li key={bid.player_id} className="flex items-center gap-2 rounded-md border border-line bg-stripe py-1 pr-3 pl-1 text-sm">
                      <img
                        src={`https://a.espncdn.com/combiner/i?img=/i/headshots/nba/players/full/${bid.player_id}.png&w=96&h=70`}
                        alt=""
                        loading="lazy"
                        width={40}
                        height={29}
                        onError={(event) => (event.currentTarget.style.visibility = 'hidden')}
                      />
                      {playerName.get(bid.player_id)}
                      <b className="tabular-nums">{money(bid.amount)}</b>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )
        })}
    </div>
  )
}

function Rules(props: {
  closesAt: string | null
  blindClosesAt: string | null
  rosterSize: number | null
  budget: number | undefined
  scoring: ScoringRule[]
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const spots = props.rosterSize ?? 13
  const swatch = 'mr-2 inline-block size-3 rounded-sm align-middle'

  return (
    <>
      <button type="button" onClick={() => dialog.current?.showModal()} className={`${pill} mr-2 font-medium hover:bg-accent/10`}>
        ⓘ Rules
      </button>
      <dialog
        ref={dialog}
        aria-labelledby="rules-title"
        className="m-auto max-h-[calc(100vh-2rem)] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-xl border border-line bg-card p-5 text-ink shadow-xl backdrop:bg-black/50 [&_h3]:mt-4 [&_h3]:font-semibold [&_li]:mt-1 [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:text-sm"
      >
        <h2 id="rules-title" className="text-lg font-bold">How the auction works</h2>

        <h3>Bidding</h3>
        <ul>
          <li>Every manager starts with {props.budget ? money(props.budget) : 'the same budget'}.</li>
          <li>
            Every bid is a <b>max bid</b>: the most you would pay. The site bids for you, only $1 over the next manager, up to
            your max.
          </li>
          <li>Nobody else can see your max. They only see the current price.</li>
          <li>
            Example: you set a $50 max on a player with no bids, and you lead at $1. Someone sets $30, the site raises you to
            $31 and they are outbid right away. Someone sets $80, they lead at $51.
          </li>
          <li>On equal maxes, the earlier one wins.</li>
          <li>You can raise your max any time. A max is final: you cannot lower, revoke, or delete it.</li>
          <li>Your full max on each player you lead is locked from your balance.</li>
          <li>
            The auction closes{' '}
            {props.closesAt ? <b>{new Date(props.closesAt).toLocaleString([], { dateStyle: 'full', timeStyle: 'short' })}</b> : 'at the deadline'}.
            Whoever leads a player at that moment wins that player at that price.
          </li>
        </ul>

        <h3>Being outbid</h3>
        <ul>
          <li>Your max keeps you in the lead until another manager sets a higher max.</li>
          <li>If that happens, you lose the player and your locked max returns to your balance right away.</li>
          <li>You get a Discord ping. You can bid on that player again or spend the money elsewhere.</li>
        </ul>

        {props.blindClosesAt && (
          <>
            <h3>Blind round</h3>
            <ul>
              <li>
                After the main auction closes, a blind round runs until{' '}
                <b>{new Date(props.blindClosesAt).toLocaleString([], { dateStyle: 'full', timeStyle: 'short' })}</b>.
              </li>
              <li>Only managers with an empty roster spot can bid, and only on players nobody won.</li>
              <li>Bids are sealed: nobody sees anyone else's bids. You can change or withdraw yours until the deadline.</li>
              <li>The highest bid wins and pays what they bid. On equal bids, the earlier one wins.</li>
              <li>
                You can bid on more players than you have spots, as backups. Results go from the highest bid down, and a bid is
                skipped once you run out of spots or money.
              </li>
            </ul>
          </>
        )}

        <h3>Row colors</h3>
        <ul className="list-none! pl-0!">
          <li><span className={`${swatch} bg-emerald-500`} />Green: you lead this player.</li>
          <li><span className={`${swatch} bg-amber-400`} />Yellow: another manager leads this player.</li>
          <li><span className={`${swatch} border border-line`} />No color: no bids yet.</li>
        </ul>

        <h3>You need {spots} players</h3>
        <ul>
          <li>Your roster has {spots} spots. Lead {spots} players before the auction closes.</li>
          <li>You cannot lead more than {spots} players at once.</li>
          <li>$1 stays reserved for each empty spot, so your max bid can be lower than your balance.</li>
          <li>The Players counter in the header shows how many you lead now.</li>
        </ul>

        <h3>Scoring</h3>
        {props.scoring.length === 0 ? (
          <p className="text-sm text-muted">Scoring is not loaded yet.</p>
        ) : (
          <table className="mt-1 w-full text-sm [&_td]:py-0.5">
            <tbody>
              {props.scoring.map((rule) => (
                <tr key={rule.stat} className="border-t border-line">
                  <td>{rule.label}</td>
                  <td className={`${numeric} font-semibold ${rule.points < 0 ? 'text-red-600' : ''}`}>
                    {rule.points > 0 && '+'}{rule.points}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="mt-2 text-xs text-muted">Projected points in the table use this scoring, from the ESPN league.</p>

        <form method="dialog" className="mt-4 flex justify-end">
          <button className={button}>Got it</button>
        </form>
      </dialog>
    </>
  )
}

function Countdown({ closesAt, label }: { closesAt: string | null; label: string }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  if (!closesAt) return <span className={pill}>No auction scheduled</span>
  const seconds = Math.floor((Date.parse(closesAt) - now) / 1000)
  if (seconds <= 0) return <span className={`${pill} font-semibold text-red-600`}>Auction closed</span>
  const days = Math.floor(seconds / 86400)
  const clock = new Date(seconds * 1000).toISOString().slice(11, 19)
  return <span className={pill}>{label} <b>{days > 0 && `${days}d `}{clock}</b></span>
}

function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className={tableWrap}>
      <table className={table}>
        <thead className={tableHead}>
          <tr>{head.map((label) => <th key={label}>{label}</th>)}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}

function PlayerPool(props: {
  players: Player[]
  leaderOf: Map<number, CurrentBid>
  maxOf: Map<number, number>
  blind: boolean
  blindBidOf: Map<number, number>
  managerName: Map<string, string>
  userId: string
  onBid: (playerId: number, amount: number) => void
  onCancelBlind: (playerId: number) => void
}) {
  const [search, setSearch] = useState('')
  const [position, setPosition] = useState('')
  const [team, setTeam] = useState('')
  const [sort, setSort] = useState(TOTAL)
  const [mineFirst, setMineFirst] = useState(true)

  const teams = useMemo(
    () => [...new Set(props.players.map((player) => player.team).filter((name): name is string => !!name))].sort(),
    [props.players],
  )
  const value = useCallback(
    (player: Player) =>
      sort === BID
        ? (props.leaderOf.get(player.id)?.amount ?? 0)
        : sort === FPTS
          ? player.projections.fantasy_avg
          : sort === TOTAL
            ? player.projections.fantasy_total
            : (player.projections.avg?.[sort] ?? 0),
    [sort, props.leaderOf],
  )
  const rows = useMemo(
    () =>
      props.players
        .filter((player) => player.name.toLowerCase().includes(search.toLowerCase()))
        .filter((player) => !position || player.positions.includes(position))
        .filter((player) => !team || player.team === team)
        .sort((a, b) => value(b) - value(a) || b.projections.fantasy_avg - a.projections.fantasy_avg),
    [props.players, search, position, team, value],
  )
  const mineRows = useMemo(
    () => rows.filter((player) => props.leaderOf.get(player.id)?.manager_id === props.userId),
    [rows, props.leaderOf, props.userId],
  )
  const otherRows = useMemo(
    () => (mineFirst ? rows.filter((player) => props.leaderOf.get(player.id)?.manager_id !== props.userId) : rows),
    [rows, mineFirst, props.leaderOf, props.userId],
  )
  const sortHeader = (label: string) => (
    <th key={label} className="text-right" aria-sort={sort === label ? 'descending' : undefined}>
      <button onClick={() => setSort(label)} className={`uppercase ${sort === label ? 'text-accent' : ''}`}>
        {label}{sort === label && ' ▼'}
      </button>
    </th>
  )
  const renderTable = (list: Player[], wrapClass: string) => (
    <div className={wrapClass}>
      <table className={table}>
        <thead className={tableHead}>
          <tr>
            <th>Player</th>
            <th>Team</th>
            <th>Pos</th>
            {SORTS.map(sortHeader)}
            <th>Leader</th>
            <th>{props.blind ? 'Sealed Bid' : 'Max Bid'}</th>
          </tr>
        </thead>
        <tbody>
          {list.map((player) => {
            const leader = props.leaderOf.get(player.id)
            const mine = leader?.manager_id === props.userId
            return (
              <PlayerRow
                key={player.id}
                player={player}
                highBid={leader?.amount ?? null}
                leaderName={leader ? (props.managerName.get(leader.manager_id) ?? null) : null}
                mine={mine}
                myMax={mine ? (props.maxOf.get(player.id) ?? null) : null}
                blind={props.blind}
                myBlindBid={props.blindBidOf.get(player.id) ?? null}
                onBid={props.onBid}
                onCancelBlind={props.onCancelBlind}
              />
            )
          })}
        </tbody>
      </table>
    </div>
  )

  return (
    <>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search players"
          aria-label="Search players"
          className={control}
        />
        <select value={position} onChange={(event) => setPosition(event.target.value)} aria-label="Position" className={control}>
          <option value="">All positions</option>
          {POSITIONS.map((name) => <option key={name}>{name}</option>)}
        </select>
        <TeamFilter teams={teams} value={team} onChange={setTeam} />
        <select value={sort} onChange={(event) => setSort(event.target.value)} aria-label="Sort by" className={control}>
          {SORTS.map((name) => <option key={name} value={name}>Sort: {name}</option>)}
        </select>
        <label className="flex items-center gap-1.5 text-sm">
          <input type="checkbox" checked={mineFirst} onChange={(event) => setMineFirst(event.target.checked)} />
          My bids on top
        </label>
        <span className="text-sm text-muted">{rows.length} players</span>
      </div>
      {/* Keep both tables mounted so toggling only remounts your few led players, not the whole pool. */}
      <div className={mineFirst ? undefined : 'hidden'}>
        <h2 className="mt-3 text-sm font-semibold text-muted">My bids ({mineRows.length})</h2>
        {mineRows.length > 0
          ? renderTable(mineRows, 'mt-2 overflow-auto rounded-lg border border-line bg-card shadow-sm')
          : <p className="mt-2 text-sm text-muted">You are not leading any players.</p>}
        <h2 className="mt-4 text-sm font-semibold text-muted">Other players ({otherRows.length})</h2>
      </div>
      {renderTable(mineFirst ? otherRows : rows, tableWrap)}
    </>
  )
}

const PlayerRow = memo(function PlayerRow({
  player,
  highBid,
  leaderName,
  mine,
  myMax,
  blind,
  myBlindBid,
  onBid,
  onCancelBlind,
}: {
  player: Player
  highBid: number | null
  leaderName: string | null
  mine: boolean
  myMax: number | null
  blind: boolean
  myBlindBid: number | null
  onBid: (playerId: number, amount: number) => void
  onCancelBlind: (playerId: number) => void
}) {
  return (
    <tr
      id={`player-${player.id}`}
      className={
        mine
          ? 'bg-emerald-500/15 shadow-[inset_3px_0_0_#10b981]'
          : highBid != null
            ? 'bg-amber-400/20 shadow-[inset_3px_0_0_#f59e0b]'
            : stripedRow
      }
    >
      <td className="whitespace-nowrap font-medium">
        <img
          src={`https://a.espncdn.com/combiner/i?img=/i/headshots/nba/players/full/${player.id}.png&w=96&h=70`}
          alt=""
          loading="lazy"
          width={48}
          height={35}
          onError={(event) => (event.currentTarget.style.visibility = 'hidden')}
          className="mr-2 inline-block"
        />
        {player.name}
        {player.injury_status && player.injury_status !== 'ACTIVE' && (
          <span className="ml-2 rounded bg-red-500/15 px-1.5 py-0.5 text-xs font-normal text-red-600">
            {player.injury_status}
          </span>
        )}
      </td>
      <td className="whitespace-nowrap text-muted">
        <TeamLogo team={player.team} size={24} />
        {player.team}
      </td>
      <td className="text-muted">{player.positions.join('/')}</td>
      <td className={`${numeric} font-bold`}>{Math.round(player.projections.fantasy_total).toLocaleString()}</td>
      <td className={numeric}>{player.projections.fantasy_avg.toFixed(1)}</td>
      {STATS.map((stat) => (
        <td key={stat} className={numeric}>{player.projections.avg?.[stat]?.toFixed(1) ?? '-'}</td>
      ))}
      <td className={`${numeric} font-semibold`}>
        {highBid != null ? money(highBid) : '-'}
        {myMax != null && <div className="text-xs font-normal text-muted">max {money(myMax)}</div>}
      </td>
      <td>{leaderName ?? <span className="text-muted">-</span>}</td>
      <td>
        {!blind ? (
          <BidForm key={`${highBid}-${myMax}`} min={(myMax ?? highBid ?? 0) + 1} onBid={(amount) => onBid(player.id, amount)} />
        ) : highBid != null ? (
          <span className="text-muted">Taken</span>
        ) : (
          <div className="flex items-center gap-2">
            <BidForm key={myBlindBid ?? 0} min={1} value={myBlindBid ?? 1} onBid={(amount) => onBid(player.id, amount)} />
            {myBlindBid != null && (
              <button type="button" onClick={() => onCancelBlind(player.id)} className="text-xs text-muted underline hover:text-red-600">
                Withdraw {money(myBlindBid)}
              </button>
            )}
          </div>
        )}
      </td>
    </tr>
  )
})

function TeamLogo({ team, size }: { team: string | null; size: number }) {
  if (!team || team === 'FA') return null
  const code = LOGO_CODES[team] ?? team.toLowerCase()
  return (
    <img
      src={`https://a.espncdn.com/combiner/i?img=/i/teamlogos/nba/500/${code}.png&w=${size * 2}&h=${size * 2}`}
      alt=""
      loading="lazy"
      width={size}
      height={size}
      onError={(event) => (event.currentTarget.style.visibility = 'hidden')}
      className="mr-1.5 inline-block"
    />
  )
}

// A native <select> cannot show images, so this is a button plus a native popover.
function TeamFilter({ teams, value, onChange }: { teams: string[]; value: string; onChange: (team: string) => void }) {
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)

  function place() {
    const box = trigger.current!.getBoundingClientRect()
    Object.assign(panel.current!.style, { inset: 'auto', top: `${box.bottom + 4}px`, left: `${box.left}px` })
  }
  function pick(team: string) {
    onChange(team)
    panel.current?.hidePopover()
  }
  const option = (team: string) =>
    `rounded-md p-1.5 text-xs hover:bg-accent/10 ${team === value ? 'bg-accent/15 font-semibold' : ''}`

  return (
    <>
      <button ref={trigger} type="button" popoverTarget="team-filter" onClick={place} className={`${control} flex items-center`}>
        <span className="sr-only">Team: </span>
        <TeamLogo team={value} size={20} />
        {value || 'All teams'}
        <span className="ml-2 text-muted">▾</span>
      </button>
      <div
        ref={panel}
        id="team-filter"
        popover="auto"
        className="m-0 rounded-lg border border-line bg-card p-2 text-ink shadow-lg"
      >
        <button
          type="button"
          onClick={() => pick('')}
          aria-pressed={!value}
          className={`mb-2 w-full rounded-md border border-accent px-3 py-2 text-sm font-semibold ${
            value ? 'text-accent hover:bg-accent/10' : 'bg-accent text-white'
          }`}
        >
          All teams
        </button>
        <div className="grid grid-cols-6 gap-1">
          {teams.map((team) => (
            <button
              key={team}
              type="button"
              onClick={() => pick(team)}
              aria-pressed={team === value}
              className={`${option(team)} flex w-14 flex-col items-center gap-0.5 [&_img]:mr-0`}
            >
              <TeamLogo team={team} size={32} />
              {team}
            </button>
          ))}
        </div>
      </div>
    </>
  )
}

function ConfirmBid(props: {
  pending: PendingBid | null
  playerName: string | undefined
  blind: boolean
  onCancel: () => void
  onConfirm: (bid: PendingBid) => Promise<void>
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [busy, setBusy] = useState(false)
  const { pending } = props

  useEffect(() => {
    if (pending) dialog.current?.showModal()
    else dialog.current?.close()
  }, [pending])

  async function confirm() {
    if (!pending) return
    setBusy(true)
    await props.onConfirm(pending)
    setBusy(false)
  }

  return (
    <dialog
      ref={dialog}
      onClose={props.onCancel}
      aria-labelledby="confirm-bid-title"
      className="m-auto w-[calc(100%-2rem)] max-w-sm rounded-xl border border-line bg-card p-5 text-ink shadow-xl backdrop:bg-black/50"
    >
      {props.blind ? (
        <>
          <h2 id="confirm-bid-title" className="text-lg font-bold">Confirm sealed bid</h2>
          <p className="mt-2">
            Bid <b>{pending && money(pending.amount)}</b> on <b>{props.playerName}</b> in the blind round?
          </p>
          <p className="mt-2 text-sm text-muted">
            Nobody else sees your bid. If it is the highest when the blind round closes, you win the player and pay this amount.
            You can change or withdraw it until then.
          </p>
        </>
      ) : (
        <>
          <h2 id="confirm-bid-title" className="text-lg font-bold">Confirm max bid</h2>
          <p className="mt-2">
            Set a max of <b>{pending && money(pending.amount)}</b> on <b>{props.playerName}</b>?
          </p>
          <p className="mt-2 text-sm text-muted">
            The site bids only as much as needed to keep you in the lead, up to your max. Other managers cannot see your max.
          </p>
          <p className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
            You are committing up to this amount. You cannot lower, revoke, or delete your max.
          </p>
        </>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" autoFocus onClick={props.onCancel} className={control}>Cancel</button>
        <button type="button" disabled={busy} onClick={confirm} className={button}>Confirm bid</button>
      </div>
    </dialog>
  )
}

function BidForm({ min, value = min, onBid }: { min: number; value?: number; onBid: (amount: number) => void }) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    onBid(Number(new FormData(event.currentTarget).get('amount')))
  }

  return (
    <form onSubmit={submit} className="flex items-center gap-1">
      <span className="text-muted">$</span>
      <input
        name="amount"
        type="number"
        min={min}
        defaultValue={value}
        required
        aria-label="Max bid amount"
        className="w-24 rounded-md border border-line bg-card px-1.5 py-1 tabular-nums"
      />
      <button className="rounded-md bg-accent px-2.5 py-1 font-medium text-white hover:brightness-110">
        Bid
      </button>
    </form>
  )
}
