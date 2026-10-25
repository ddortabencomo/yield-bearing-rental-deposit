import React from "react"
import { RentalDeposit } from "../components/RentalDeposit"

const Check = ({ color }: { color: string }) => (
	<svg
		width="24"
		height="24"
		viewBox="0 0 24 24"
		fill="none"
		stroke={color}
		strokeWidth="2.8"
		strokeLinecap="round"
		strokeLinejoin="round"
		aria-hidden="true"
	>
		<path d="M4 12l5 5L20 6" />
	</svg>
)

const ruleIcon = {
	ready: (
		<>
			<rect x="6" y="10" width="28" height="22" rx="4" />
			<path d="M6 17h28M24 25h5" />
		</>
	),
	shield: (
		<>
			<path d="M20 5l13 5v9c0 8-5.5 13.5-13 16C12.5 32.5 7 27 7 19v-9z" />
			<path d="M14 20l4.5 4.5L27 16" />
		</>
	),
	lock: (
		<>
			<rect x="9" y="18" width="22" height="16" rx="3" />
			<path d="M14 18v-5a6 6 0 0 1 12 0v5" />
		</>
	),
	clock: (
		<>
			<circle cx="20" cy="20" r="14" />
			<path d="M20 12v8l5 4" />
		</>
	),
}

const RuleIcon = ({ name }: { name: keyof typeof ruleIcon }) => (
	<div className="rule-icon">
		<svg
			width="34"
			height="34"
			viewBox="0 0 40 40"
			fill="none"
			stroke="#0F0F0F"
			strokeWidth="2.6"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			{ruleIcon[name]}
		</svg>
	</div>
)

const Home: React.FC = () => (
	<>
		{/* ---------- Hero ---------- */}
		<section className="hero" id="top">
			<div className="container">
				<div className="hero-text">
					<p className="pill pill-dark">For renters and landlords</p>
					<h1 className="display">
						Your rental deposit can <span className="highlight">make you money</span>.
					</h1>
					<p className="lead">
						When you rent a home, your deposit sits still for years. Blendlord keeps it
						safe and puts it to work. When you move out, you get your deposit back plus
						the money it made.
					</p>
					<div className="btn-row">
						<a className="btn btn-primary" href="#app">
							I rent a home
						</a>
						<a className="btn btn-outline" href="/?new=1#app">
							I own a home
						</a>
					</div>
				</div>
				<div className="hero-visual">
					<div className="example-card">
						<p className="label">Example deposit</p>
						<p className="amount">$2,000</p>
						<svg viewBox="0 0 376 120" fill="none" aria-hidden="true">
							<path
								d="M4 110 C 90 104, 150 92, 210 74 S 320 30, 372 12 L 372 120 L 4 120 Z"
								fill="#FDDA24"
								opacity="0.18"
							/>
							<path
								d="M4 110 C 90 104, 150 92, 210 74 S 320 30, 372 12"
								stroke="#FDDA24"
								strokeWidth="4"
								strokeLinecap="round"
							/>
							<circle cx="372" cy="12" r="7" fill="#FDDA24" />
						</svg>
						<p className="growth">Making money every day while you live there</p>
						<div className="moveout">
							<p className="label">The day you move out</p>
							<div className="line-item">
								<span>Repairs you agreed to</span>
								<strong>$150</strong>
							</div>
							<div className="line-item total">
								<span>Back to you</span>
								<span>$1,850 + all the interest</span>
							</div>
						</div>
					</div>
				</div>
			</div>
		</section>

		{/* ---------- Problem ---------- */}
		<section className="section section-dark">
			<div className="container">
				<h2 className="h2" style={{ maxWidth: "18ch" }}>
					Today, your deposit is money doing{" "}
					<span style={{ color: "var(--yellow)" }}>nothing</span>.
				</h2>
				<div className="row">
					<div className="problem">
						<h3>It earns nothing</h3>
						<p>One or two months of rent, locked away for years. Not a cent of interest for you.</p>
					</div>
					<div className="problem">
						<h3>Someone else holds it</h3>
						<p>Your money sits with your landlord, not with you, for as long as you rent.</p>
					</div>
					<div className="problem">
						<h3>Getting it back is a fight</h3>
						<p>At the end, the person holding the money decides how much to keep.</p>
					</div>
				</div>
			</div>
		</section>

		{/* ---------- How it works ---------- */}
		<section className="section" id="how">
			<div className="container">
				<h2 className="h2">How it works</h2>
				<p className="lead">Four simple steps. No middleman holding your money.</p>
				<div className="row">
					<div className="step">
						<p className="step-num">1</p>
						<h3 className="h3">Your landlord sends the terms</h3>
						<p>Amount, end of the lease and a neutral arbiter. You see everything before you pay.</p>
					</div>
					<div className="step">
						<p className="step-num">2</p>
						<h3 className="h3">You pay your deposit</h3>
						<p>It goes into a safe, neutral account. Not to the landlord, not to us.</p>
					</div>
					<div className="step">
						<p className="step-num">3</p>
						<h3 className="h3">It earns interest</h3>
						<p>While you live in the home, part of your deposit grows a little every day.</p>
					</div>
					<div className="step">
						<p className="step-num">4</p>
						<h3 className="h3">You move out, money moves</h3>
						<p>The landlord gets the agreed repairs. You get everything else, plus all the interest.</p>
					</div>
				</div>
			</div>
		</section>

		{/* ---------- Fair for both sides ---------- */}
		<section className="section section-gray">
			<div className="container">
				<h2 className="h2">Fair for both sides</h2>
				<div className="row" style={{ marginTop: 48 }}>
					<div className="side-card dark">
						<h3>If you rent</h3>
						<ul className="checklist">
							<li>
								<Check color="#FDDA24" />
								Your deposit earns interest, and the interest is yours.
							</li>
							<li>
								<Check color="#FDDA24" />
								Nobody can take money without your yes, or a neutral arbiter&apos;s
								decision.
							</li>
							<li>
								<Check color="#FDDA24" />
								If your landlord never asks for anything, you get everything back 14 days
								after the lease ends.
							</li>
						</ul>
					</div>
					<div className="side-card yellow">
						<h3>If you own the home</h3>
						<ul className="checklist">
							<li>
								<Check color="#0F0F0F" />
								The deposit is really there, locked for the whole lease.
							</li>
							<li>
								<Check color="#0F0F0F" />
								Agreed repairs are paid to you first, right away.
							</li>
							<li>
								<Check color="#0F0F0F" />
								If your tenant never answers, your request is paid 14 days after the
								lease ends.
							</li>
						</ul>
					</div>
				</div>
			</div>
		</section>

		{/* ---------- Is it safe? ---------- */}
		<section className="section" id="safe">
			<div className="container">
				<h2 className="h2">Is my money safe?</h2>
				<p className="lead">
					Four simple rules protect every deposit. They are written in the code, so nobody
					can change them.
				</p>
				<div className="row">
					<div className="rule">
						<RuleIcon name="ready" />
						<h3 className="h3">Some money is always ready</h3>
						<p>
							At least 20% of the deposit never leaves. Repairs are paid from it on the
							spot, even if the lending pool is busy that day.
						</p>
					</div>
					<div className="rule">
						<RuleIcon name="clock" />
						<h3 className="h3">It comes home early</h3>
						<p>
							In the last 30 days of the lease, the money can leave the lending pool, so
							your payout never depends on the pool that day.
						</p>
					</div>
					<div className="rule">
						<RuleIcon name="shield" />
						<h3 className="h3">Landlord first, never more</h3>
						<p>
							Agreed repairs are paid first; nobody can ever take more than the deposit.
							Everything else is yours.
						</p>
					</div>
					<div className="rule">
						<RuleIcon name="lock" />
						<h3 className="h3">You can say no</h3>
						<p>
							Disagree with a repair and nothing moves. A neutral arbiter decides, and
							can never award more than the landlord asked.
						</p>
					</div>
				</div>
			</div>
		</section>

		{/* ---------- The app ---------- */}
		<section className="app-section" id="app">
			<div className="container">
				<p className="pill pill-dark">Live on Stellar testnet</p>
				<h2 className="h2" style={{ marginTop: 16 }}>
					Try it with real money flows
				</h2>
				<p className="lead">
					Connect Freighter on Testnet. Landlords create an agreement; tenants open the link
					they receive, check the terms and lock the deposit. Every number below is read
					live from the contract and from Blend.
				</p>
				<RentalDeposit />
			</div>
		</section>

		{/* ---------- FAQ ---------- */}
		<section className="section section-gray" id="faq">
			<div className="container faq">
				<h2 className="h2">Questions people ask</h2>
				<div className="faq-list">
					<div className="faq-item">
						<h3 className="h3">Who holds my money?</h3>
						<p>
							Nobody. It sits in a public program on Stellar that follows fixed rules. Not
							the landlord, not Blendlord.
						</p>
					</div>
					<div className="faq-item">
						<h3 className="h3">Where does the interest come from?</h3>
						<p>
							Part of the deposit is lent through Blend, a lending service on the Stellar
							network. Borrowers pay interest, and that interest goes to you.
						</p>
					</div>
					<div className="faq-item">
						<h3 className="h3">How much of my deposit is invested?</h3>
						<p>
							At most 80%. Our risk model picks the share so the chance of a delayed
							payout stays below 0.5%, and shows you that chance before you pay.
						</p>
					</div>
					<div className="faq-item">
						<h3 className="h3">What if we disagree on repairs?</h3>
						<p>
							You press &quot;Dispute&quot; and the money stays locked. A neutral arbiter
							decides, never more than the landlord asked. If the arbiter doesn&apos;t act
							within 30 days after the lease ends, you get your deposit back.
						</p>
					</div>
					<div className="faq-item">
						<h3 className="h3">What if the lending pool is busy when I move out?</h3>
						<p>
							The money that is always ready pays first, right away. The rest follows as
							soon as the pool can return it, and anyone can trigger that payment.
						</p>
					</div>
					<div className="faq-item">
						<h3 className="h3">Do I need to understand crypto?</h3>
						<p>
							Our goal is no. In today&apos;s demo you connect a Stellar wallet. Deposits
							are held in a digital dollar (USDC), so the value does not jump around.
						</p>
					</div>
				</div>
			</div>
		</section>

		{/* ---------- CTA ---------- */}
		<section className="section" id="start">
			<div className="container">
				<div className="cta">
					<div>
						<h2 className="h2">Put your deposit to work.</h2>
						<p>Try the demo and watch a deposit make money, step by step.</p>
					</div>
					<div className="btn-row">
						<a className="btn btn-dark" href="#app">
							I rent a home
						</a>
						<a className="btn btn-outline" href="/?new=1#app" style={{ borderColor: "var(--white)" }}>
							I own a home
						</a>
					</div>
				</div>
			</div>
		</section>
	</>
)

export default Home
