import { createClient } from '@supabase/supabase-js'

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
)

export type Player = {
  id: number
  name: string
  team: string | null
  positions: string[]
  injury_status: string | null
  projections: { fantasy_avg: number; fantasy_total: number; avg: Record<string, number> }
}
export type ScoringRule = { stat: string; label: string; points: number }
export type CurrentBid = { player_id: number; manager_id: string; amount: number; created_at: string }
export type Bid = CurrentBid & { id: number; created_at: string; auto: boolean; blind: boolean }
// a manager's own private amount on a player: a max bid in the main round, a sealed bid in the blind round
export type MaxBid = { player_id: number; amount: number }
export type BidResult = { leading: boolean; price: number; max: number }
export type Budget = {
  manager_id: string
  name: string
  budget: number
  committed: number
  players_led: number
  remaining: number
  max_bid: number
}
