import { Outlet, Route, Routes } from "react-router-dom"
import styles from "./App.module.css"
import ConnectAccount from "./components/ConnectAccount"
import Debug from "./pages/Debug"
import Home from "./pages/Home"

function App() {
	return (
		<Routes>
			<Route element={<AppLayout />}>
				<Route path="/" element={<Home />} />
				<Route path="/debug" element={<Debug />} />
				<Route path="/debug/:contractName" element={<Debug />} />
			</Route>
		</Routes>
	)
}

export const Logo = ({ size = 36 }: { size?: number }) => (
	<svg
		width={size}
		height={size}
		viewBox="0 0 40 40"
		fill="none"
		stroke="#0F0F0F"
		strokeWidth="2.6"
		strokeLinecap="round"
		strokeLinejoin="round"
		aria-hidden="true"
	>
		<path d="M5 19L20 6l15 13v15H5z" fill="#FDDA24" stroke="#FDDA24" />
		<path d="M13 27l5-5 4 3 6-7" />
		<path d="M24 18h4v4" />
	</svg>
)

const AppLayout = () => (
	<div className={styles.AppLayout}>
		<header className={styles.header}>
			<a className={styles.logo} href="/">
				<Logo />
				<span>Blendlord</span>
			</a>
			<nav className={styles.headerNav} aria-label="Main">
				<a href="/#how">How it works</a>
				<a href="/#safe">Is it safe?</a>
				<a href="/#faq">Questions</a>
				<a href="/#app">Try it</a>
			</nav>
			<ConnectAccount />
		</header>

		<main className={styles.main}>
			<Outlet />
		</main>

		<footer className={styles.footer}>
			<span className={styles.brand}>Blendlord</span>
			<span>Built at HackMeridian 2026 on Stellar, with Blend · testnet demo</span>
			<a
				href="https://github.com/ddortabencomo/yield-bearing-rental-deposit"
				target="_blank"
				rel="noreferrer"
			>
				GitHub
			</a>
		</footer>
	</div>
)

export default App
