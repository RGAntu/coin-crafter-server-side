require("dotenv").config();
const express = require("express");
const app = express();
const cors = require("cors");
const port = process.env.PORT || 5000;
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

// Middleware
app.use(cors());
app.use(express.json());

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
