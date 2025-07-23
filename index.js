require("dotenv").config();
const express = require("express");
const app = express();
const cors = require("cors");
const port = process.env.PORT || 5000;
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const { default: Stripe } = require("stripe");

// Middleware
app.use(cors());
app.use(express.json());

// Initialize Stripe with your secret key
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// MongoDB setup
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.m3lhrmy.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    // await client.connect();

    const db = client.db("coinCrafterDB");
    const usersCollection = db.collection("users");
    const tasksCollection = db.collection("tasks");
    const submissionsCollection = db.collection("submissions");
    const paymentsCollection = db.collection("payments");

    // Endpoint to save user data
    app.post("/users", async (req, res) => {
      const newUser = req.body;

      if (!newUser?.email) {
        return res.status(400).send({ error: "Email is required." });
      }

      // Check if the user already exists
      const existingUser = await usersCollection.findOne({
        email: newUser.email,
      });

      if (existingUser) {
        return res.status(409).send({ error: "User already exists." });
      }

      // Insert the user
      const result = await usersCollection.insertOne(newUser);
      res.status(201).send(result);
    });

    //  Route to get user role by email
    app.get("/users/role", async (req, res) => {
      const email = req.query.email;

      if (!email) {
        return res.status(400).send({ error: "Email query is required." });
      }

      const user = await usersCollection.findOne({ email });

      if (!user) {
        return res.status(404).send({ error: "User not found." });
      }

      //  Send only the role (not full user)
      res.send({ role: user.role || "user" });
    });

    app.get("/users/:email", async (req, res) => {
      const email = req.params.email;
      const user = await db.collection("users").findOne({ email });
      res.send(user);
    });

    app.patch("/users/coins/:email", async (req, res) => {
      const email = req.params.email;
      const { amount } = req.body;
      const result = await db
        .collection("users")
        .updateOne({ email }, { $inc: { coins: amount } });
      res.send(result);
    });

    // Buyer

    // Get Buyer Stats
    app.get("/stats", async (req, res) => {
      const buyerEmail = req.query.email;
      if (!buyerEmail) return res.status(400).send({ error: "Email required" });

      const totalTasks = await tasksCollection.countDocuments({
        buyer_email: buyerEmail,
      });

      const pendingWorkers = await submissionsCollection.countDocuments({
        buyer_email: buyerEmail,
        status: "pending",
      });

      const paidSubmissions = await submissionsCollection
        .find({ buyer_email: buyerEmail, status: "approved" })
        .toArray();

      const totalPaid = paidSubmissions.reduce(
        (sum, sub) => sum + (sub.payable_amount || 0),
        0
      );

      res.send({
        totalTasks,
        pendingWorkers,
        totalPaid,
      });
    });

    //  Get Pending Submissions
    app.get("/pending-submissions", async (req, res) => {
      const buyerEmail = req.query.email;
      if (!buyerEmail) return res.status(400).send({ error: "Email required" });

      const submissions = await submissionsCollection
        .find({ buyer_email: buyerEmail, status: "pending" })
        .toArray();

      res.send(submissions);
    });

    // 1. Create Payment Intent
    app.post("/create-payment-intent", async (req, res) => {
      const { amount } = req.body;
      if (!amount) {
        return res.status(400).json({ error: "Amount is required" });
      }

      try {
        // Stripe expects amount in cents (e.g. $1 = 100 cents)
        const paymentIntent = await stripe.paymentIntents.create({
          amount: Math.round(amount * 100), // convert dollars to cents
          currency: "usd",
          payment_method_types: ["card"],
        });

        res.json({ clientSecret: paymentIntent.client_secret });
      } catch (error) {
        console.error("Stripe error:", error);
        res.status(500).json({ error: "Failed to create payment intent" });
      }
    });

    // 2. Save payment info and update user's coins
    app.post("/payments", async (req, res) => {
      const { email, amount, transactionId, date, coins } = req.body;

      if (!email || !amount || !transactionId || !coins) {
        return res.status(400).json({ error: "Missing payment info" });
      }

      try {
        // Save payment record
        const paymentDoc = {
          email,
          amount,
          transactionId,
          date: new Date(date),
          coins,
        };
        await paymentsCollection.insertOne(paymentDoc);

        // Update user's coin balance (increment coins)
        const updateResult = await usersCollection.updateOne(
          { email },
          { $inc: { coins: coins } }
        );

        if (updateResult.matchedCount === 0) {
          return res.status(404).json({ error: "User not found" });
        }

        res.json({ message: "Payment saved and coins updated" });
      } catch (error) {
        console.error("Payment saving error:", error);
        res.status(500).json({ error: "Failed to save payment info" });
      }
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Coin Crafter is your Micro task and earning platform");
});

app.listen(port, () => {
  console.log(`Coin Crafter is running on port ${port}`);
});
