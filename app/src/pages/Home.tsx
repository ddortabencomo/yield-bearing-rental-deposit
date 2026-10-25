import React from "react"
import { RentalDeposit } from "../components/RentalDeposit"
import styles from "./Home.module.css"

const Home: React.FC = () => (
	<div className={styles.Home}>
		<div className={styles.hero}>
			<h1>Rental deposits that earn yield</h1>
			<p>
				Your deposit is held by a neutral Soroban contract, earns interest in
				Blend while the lease runs, and is released with a fixed waterfall:
				the landlord&apos;s deduction first, then everything else, yield
				included, back to the tenant.
			</p>
		</div>
		<RentalDeposit />
	</div>
)

export default Home
